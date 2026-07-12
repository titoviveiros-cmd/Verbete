
-- 1) Coluna phase_started_at para rastrear início da fase atual
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS phase_started_at timestamptz;

-- 2) Backfill mínimo: para salas em fase ativa, assume agora
UPDATE public.rooms SET phase_started_at = now()
  WHERE phase_started_at IS NULL
    AND status IN ('writing','voting','reveal','choosing','shuffling');

-- 3) advance_writing_to_voting passa a registrar phase_started_at
CREATE OR REPLACE FUNCTION public.advance_writing_to_voting(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_word public.words;
  v_def_ids uuid[];
  v_letters text := 'ABCDEFGHIJKLM';
  v_id uuid;
  v_idx int := 1;
  v_truth text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'writing' THEN RETURN; END IF;
  IF v_room.current_word_id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_word FROM public.words WHERE id = v_room.current_word_id;
  IF v_word IS NULL THEN RETURN; END IF;

  v_truth := lower(extensions.unaccent(v_word.meaning));
  v_truth := regexp_replace(v_truth, '^(\(?[a-z]{1,5}\.(\s*[a-z]{1,5}\.)?\)?|\([^)]{1,30}\))[\s:;,-]+', '', 'g');
  v_truth := regexp_replace(v_truth, '^(\(?[a-z]{1,5}\.(\s*[a-z]{1,5}\.)?\)?|\([^)]{1,30}\))[\s:;,-]+', '', 'g');
  v_truth := split_part(v_truth, ';', 1);
  v_truth := btrim(v_truth);
  IF char_length(v_truth) > 60 THEN
    v_truth := substring(v_truth from 1 for 60);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.definitions
    WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = true
  ) THEN
    INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
    VALUES (p_room_id, v_room.current_round, '__truth__', v_truth, true);
  END IF;

  SELECT array_agg(id ORDER BY random()) INTO v_def_ids
  FROM public.definitions
  WHERE room_id = p_room_id AND round = v_room.current_round;

  FOREACH v_id IN ARRAY v_def_ids LOOP
    UPDATE public.definitions SET letter = substr(v_letters, v_idx, 1) WHERE id = v_id;
    v_idx := v_idx + 1;
  END LOOP;

  UPDATE public.rooms
  SET status = 'voting',
      round_phase_ends_at = now() + interval '30 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;
END;
$function$;

-- 4) extend_writing_or_advance: grace de 2s + ignorar entradas tardias
CREATE OR REPLACE FUNCTION public.extend_writing_or_advance(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_pending record;
  v_extended boolean := false;
  v_kicked text[] := ARRAY[]::text[];
  v_extended_players text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;

  -- Grace de 2s: nunca penaliza antes do fim real do timer + buffer de rede.
  IF v_room.round_phase_ends_at IS NOT NULL
     AND v_room.round_phase_ends_at > now() - interval '2 seconds' THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  -- Reseta extensions de jogadores que entregaram nesta rodada
  UPDATE public.players p
    SET writing_extensions = 0
    WHERE p.room_id = p_room_id
      AND p.kicked_at IS NULL
      AND p.is_bot = false
      AND p.writing_extensions > 0
      AND EXISTS (
        SELECT 1 FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      );

  FOR v_pending IN
    SELECT p.id, p.writing_extensions
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.is_connected = true
      AND p.kicked_at IS NULL
      AND p.id <> COALESCE(v_room.current_coordinator, '')
      -- Ignora quem entrou DEPOIS do início da fase (não teve tempo)
      AND (v_room.phase_started_at IS NULL
           OR p.joined_at <= v_room.phase_started_at + interval '3 seconds')
      AND NOT EXISTS (
        SELECT 1 FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      )
  LOOP
    IF v_pending.writing_extensions < 2 THEN
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            writing_extensions = writing_extensions + 1
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.writing_extensions + 1)
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
    ELSE
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            kicked_at = now(),
            is_connected = false
        WHERE id = v_pending.id;
      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    UPDATE public.rooms
      SET round_phase_ends_at = now() + interval '20 seconds',
          phase_started_at = now()
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'extended_players', to_jsonb(v_extended_players),
      'kicked', to_jsonb(v_kicked)
    );
  END IF;

  PERFORM public.advance_writing_to_voting(p_room_id);
  RETURN jsonb_build_object(
    'action', 'advanced',
    'kicked', to_jsonb(v_kicked)
  );
END;
$function$;

-- 5) extend_voting_or_advance: mesmas proteções
CREATE OR REPLACE FUNCTION public.extend_voting_or_advance(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_pending record;
  v_extended boolean := false;
  v_kicked text[] := ARRAY[]::text[];
  v_extended_players text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;

  IF v_room.round_phase_ends_at IS NOT NULL
     AND v_room.round_phase_ends_at > now() - interval '2 seconds' THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  UPDATE public.players p
    SET voting_extensions = 0
    WHERE p.room_id = p_room_id
      AND p.kicked_at IS NULL
      AND p.is_bot = false
      AND p.voting_extensions > 0
      AND EXISTS (
        SELECT 1 FROM public.votes v
        WHERE v.room_id = p_room_id
          AND v.round = v_room.current_round
          AND v.voter_id = p.id
      );

  FOR v_pending IN
    SELECT p.id, p.voting_extensions
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.is_connected = true
      AND p.kicked_at IS NULL
      AND (v_room.phase_started_at IS NULL
           OR p.joined_at <= v_room.phase_started_at + interval '3 seconds')
      AND NOT EXISTS (
        SELECT 1 FROM public.votes v
        WHERE v.room_id = p_room_id
          AND v.round = v_room.current_round
          AND v.voter_id = p.id
      )
  LOOP
    IF v_pending.voting_extensions < 2 THEN
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            voting_extensions = voting_extensions + 1
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.voting_extensions + 1)
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
    ELSE
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            kicked_at = now(),
            is_connected = false
        WHERE id = v_pending.id;
      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    UPDATE public.rooms
      SET round_phase_ends_at = now() + interval '15 seconds',
          phase_started_at = now()
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'extended_players', to_jsonb(v_extended_players),
      'kicked', to_jsonb(v_kicked)
    );
  END IF;

  PERFORM public.advance_voting_to_reveal(p_room_id);
  RETURN jsonb_build_object(
    'action', 'advanced',
    'kicked', to_jsonb(v_kicked)
  );
END;
$function$;

-- 6) rejoin_room: ao reentrar mid-fase, marca joined_at = agora para
--    indicar que o jogador NÃO estava presente quando a fase começou.
--    Isso, combinado com o filtro acima, evita penalidade injusta na
--    rodada em curso. A pontuação e o histórico são preservados.
CREATE OR REPLACE FUNCTION public.rejoin_room(p_code text, p_player_id text, p_nickname text, p_avatar text, p_color text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_existing public.players;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RAISE EXCEPTION 'room_not_found';
  END IF;

  SELECT * INTO v_existing FROM public.players WHERE id = p_player_id AND room_id = v_room.id LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.players
      SET kicked_at = NULL,
          is_connected = true,
          writing_extensions = 0,
          voting_extensions = 0,
          -- Se a sala está em fase ativa, "renova" o joined_at para que o
          -- jogador seja tratado como entrada tardia e não leve penalidade
          -- na rodada que já estava em andamento.
          joined_at = CASE
            WHEN v_room.status IN ('writing','voting') THEN now()
            ELSE v_existing.joined_at
          END,
          nickname = COALESCE(NULLIF(p_nickname, ''), nickname),
          avatar = COALESCE(NULLIF(p_avatar, ''), avatar),
          color = COALESCE(NULLIF(p_color, ''), color)
      WHERE id = p_player_id;
  ELSE
    INSERT INTO public.players (id, room_id, nickname, avatar, color, is_connected)
    VALUES (p_player_id, v_room.id, p_nickname, p_avatar, p_color, true);
  END IF;

  RETURN to_jsonb(v_room);
END;
$function$;


