
-- 1) Adiciona kicked_at à tabela players para preservar a pontuação
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS kicked_at timestamptz;

-- 2) get_room_state: exclui jogadores removidos da listagem ativa
CREATE OR REPLACE FUNCTION public.get_room_state(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'room', to_jsonb(v_room),
    'players', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.joined_at)
      FROM public.players p
      WHERE p.room_id = v_room.id AND p.kicked_at IS NULL
    ), '[]'::jsonb),
    'definitions', COALESCE((
      SELECT jsonb_agg(to_jsonb(d))
      FROM public.definitions d
      WHERE d.room_id = v_room.id AND d.round = v_room.current_round
    ), '[]'::jsonb),
    'votes', COALESCE((
      SELECT jsonb_agg(to_jsonb(v))
      FROM public.votes v
      WHERE v.room_id = v_room.id AND v.round = v_room.current_round
    ), '[]'::jsonb),
    'word', (
      SELECT to_jsonb(w) FROM public.words w WHERE w.id = v_room.current_word_id
    )
  );
END;
$function$;

-- 3) extend_writing_or_advance: NÃO deleta o jogador (preserva score),
--    marca kicked_at; ignora quem já está kicked; zera extensions de quem
--    entregou esta rodada (penalidades só acumulam em faltas consecutivas).
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
      -- Em vez de DELETE, marca kicked_at preservando a pontuação
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
      SET round_phase_ends_at = now() + interval '20 seconds'
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

-- 4) extend_voting_or_advance: mesma lógica
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

  -- Reseta extensions de quem votou nesta rodada
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
      SET round_phase_ends_at = now() + interval '15 seconds'
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

-- 5) RPC rejoin_room: permite jogador removido voltar com a mesma pontuação
CREATE OR REPLACE FUNCTION public.rejoin_room(
  p_code text,
  p_player_id text,
  p_nickname text,
  p_avatar text,
  p_color text
)
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
    -- Limpa kicked_at e reseta extensions para nova chance; preserva score
    UPDATE public.players
      SET kicked_at = NULL,
          is_connected = true,
          writing_extensions = 0,
          voting_extensions = 0,
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

GRANT EXECUTE ON FUNCTION public.rejoin_room(text, text, text, text, text) TO anon, authenticated, service_role;


