-- Tempos proporcionais para salas grandes (2026-07-27, pedido do Tito):
-- até 6 jogadores os tempos atuais ficam EXATAMENTE como estão; de 7 a 12
-- jogadores todos os tempos de fase crescem com fator n/6 (12 jogadores = 2x)
-- para dar tempo de ler todas as cédulas da votação.
--
-- Espelho no client: src/lib/game-times.ts (contagens locais e barras).
-- Fonte autoritativa: public.phase_secs, usada por todas as RPCs de fase.
-- advance_voting_to_reveal, finish_reveal e tick_stalled_rooms NÃO mudam:
-- seus tempos são relativos a round_phase_ends_at (escalam sozinhos) ou
-- backstops largos (120s) que continuam maiores que qualquer hold escalado.
--
-- ROLLBACK: reaplicar os corpos anteriores destas funções (migrations
-- 20260722130000 / 20260722100000 / 20260721150000 / 20260720100000) e
-- DROP FUNCTION public.phase_secs(uuid, integer).

-- Fator de tempo da sala: conta jogadores ativos (humanos e bots — todos
-- geram cédulas), piso 1 (≤6 jogadores) e teto 2 (12 jogadores).
CREATE OR REPLACE FUNCTION public.phase_secs(p_room_id uuid, p_base integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT round(p_base * GREATEST(1.0, LEAST(12, count(*))::numeric / 6.0))::int
  FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.phase_secs(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phase_secs(uuid, integer) TO anon, authenticated, service_role;

-- ===== start_game: escolha da 1ª rodada escala =====
CREATE OR REPLACE FUNCTION public.start_game(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_reason text;
  v_min_count int;
  v_next_coordinator text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'lobby' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;
  v_reason := public.assert_actor_identity(p_room_id, v_room.host_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  UPDATE public.players
  SET score = 0, coordinator_count = 0, writing_extensions = 0, voting_extensions = 0
  WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  DELETE FROM public.round_extensions WHERE room_id = p_room_id;

  SELECT min(coordinator_count) INTO v_min_count
  FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL;
  SELECT id INTO v_next_coordinator FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count = v_min_count
  ORDER BY random() LIMIT 1;

  UPDATE public.rooms
  SET status = 'choosing',
      current_round = 1,
      current_coordinator = v_next_coordinator,
      current_word_id = NULL,
      round_phase_ends_at = now() + make_interval(secs => public.phase_secs(p_room_id, 60)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'coordinator', v_next_coordinator);
END;
$function$;

-- ===== choose_word: escrita escala (client manda a base de 60s) =====
CREATE OR REPLACE FUNCTION public.choose_word(p_room_id uuid, p_word_id uuid, p_duration_sec integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'choosing' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;
  IF v_room.current_word_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_chosen'); END IF;

  UPDATE public.rooms
  SET status = 'writing',
      current_word_id = p_word_id,
      used_word_ids = CASE
        WHEN p_word_id = ANY(used_word_ids) THEN used_word_ids
        ELSE array_append(used_word_ids, p_word_id)
      END,
      round_phase_ends_at = now() + make_interval(secs => public.phase_secs(p_room_id, p_duration_sec)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- ===== advance_choosing_to_writing: escrita pós-sorteio escala =====
CREATE OR REPLACE FUNCTION public.advance_choosing_to_writing(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_word public.words;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'choosing' THEN RETURN jsonb_build_object('action', 'noop'); END IF;
  IF v_room.current_word_id IS NOT NULL THEN RETURN jsonb_build_object('action', 'noop'); END IF;
  IF v_room.round_phase_ends_at IS NULL OR v_room.round_phase_ends_at > now() THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  SELECT * INTO v_word FROM public.get_random_words(v_room.used_word_ids, 2, 1, v_room.categories, v_room.nivel) LIMIT 1;
  IF v_word IS NULL THEN
    -- retry técnico, não é tempo de jogo: fica fixo
    UPDATE public.rooms SET round_phase_ends_at = now() + interval '60 seconds' WHERE id = p_room_id;
    RETURN jsonb_build_object('action', 'noop_no_words');
  END IF;

  UPDATE public.rooms
  SET status = 'writing',
      current_word_id = v_word.id,
      used_word_ids = array_append(v_room.used_word_ids, v_word.id),
      round_phase_ends_at = now() + make_interval(secs => public.phase_secs(p_room_id, 60)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('action', 'auto_picked', 'word_id', v_word.id);
END;
$function$;

-- ===== advance_writing_to_voting: VOTAÇÃO escala (o motivo do pedido) =====
CREATE OR REPLACE FUNCTION public.advance_writing_to_voting(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_meaning text;
  v_def_ids uuid[];
  v_letters text := 'ABCDEFGHIJKLM';
  v_id uuid;
  v_idx int := 1;
  v_truth text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status NOT IN ('writing', 'shuffling') THEN RETURN; END IF;
  IF v_room.current_word_id IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.kicked_at IS NULL
      AND p.id <> COALESCE(v_room.current_coordinator, '')
      AND (v_room.phase_started_at IS NULL OR p.joined_at <= v_room.phase_started_at + interval '3 seconds')
      AND NOT EXISTS (
        SELECT 1
        FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      )
  ) THEN
    RETURN;
  END IF;

  -- Significado: banco global OU palavra customizada da sala (bugfix)
  SELECT w.meaning INTO v_meaning FROM public.words w WHERE w.id = v_room.current_word_id;
  IF v_meaning IS NULL THEN
    SELECT rw.meaning INTO v_meaning FROM public.room_words rw WHERE rw.id = v_room.current_word_id;
  END IF;
  IF v_meaning IS NULL THEN RETURN; END IF;

  v_truth := lower(extensions.unaccent(v_meaning));
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

  SELECT array_agg(d.id ORDER BY random()) INTO v_def_ids
  FROM public.definitions d
  WHERE d.room_id = p_room_id AND d.round = v_room.current_round;

  FOREACH v_id IN ARRAY v_def_ids LOOP
    UPDATE public.definitions SET letter = substr(v_letters, v_idx, 1) WHERE id = v_id;
    v_idx := v_idx + 1;
  END LOOP;

  UPDATE public.rooms
  SET status = 'voting',
      round_phase_ends_at = now() + make_interval(secs => public.phase_secs(p_room_id, 30)),
      phase_started_at = now()
  WHERE id = p_room_id;
END;
$function$;

-- ===== advance_reveal_to_scoreboard: espera mínima escala + folga =====
CREATE OR REPLACE FUNCTION public.advance_reveal_to_scoreboard(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_scored_at timestamptz;
  v_wait int;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'reveal' THEN RETURN; END IF;
  SELECT scored_at INTO v_scored_at FROM public.rounds
  WHERE room_id = p_room_id AND round = v_room.current_round LIMIT 1;
  -- Salas grandes: coreografia tem mais cédulas + hold escalado no client;
  -- +6s de folga garante que o cron nunca corta a revelação no meio.
  v_wait := public.phase_secs(p_room_id, 20);
  IF v_wait > 20 THEN v_wait := v_wait + 6; END IF;
  IF v_scored_at IS NULL OR v_scored_at > now() - make_interval(secs => v_wait) THEN RETURN; END IF;
  -- Backstop de 120s no placar (antes herdava deadline vencido e o tick
  -- seguinte avançava sozinho por cima do host).
  UPDATE public.rooms
  SET status = 'scoreboard',
      round_phase_ends_at = now() + interval '120 seconds'
  WHERE id = p_room_id;
END;
$function$;

-- ===== advance_scoreboard_to_next_round_or_finished: escolha escala =====
CREATE OR REPLACE FUNCTION public.advance_scoreboard_to_next_round_or_finished(p_room_id uuid, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_max_score int;
  v_won boolean;
  v_min_count int;
  v_next_coordinator text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'scoreboard' THEN RETURN jsonb_build_object('action', 'noop'); END IF;

  IF NOT p_force AND (v_room.round_phase_ends_at IS NULL OR v_room.round_phase_ends_at > now()) THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  IF v_room.mode = 'teams' AND jsonb_array_length(v_room.teams) > 0 THEN
    SELECT COALESCE(MAX(team_total), 0) INTO v_max_score FROM (
      SELECT COALESCE(SUM(p.score), 0) AS team_total
      FROM jsonb_array_elements(v_room.teams) t
      LEFT JOIN public.players p ON p.room_id = p_room_id AND p.team_id = t->>'id'
      GROUP BY t->>'id'
    ) totals;
  ELSE
    SELECT COALESCE(MAX(score), 0) INTO v_max_score FROM public.players WHERE room_id = p_room_id;
  END IF;

  -- v2: modo 'rounds' = número fixo de rodadas jogadas (win_target).
  -- Modo 'score' segue igual: primeiro a atingir win_target pontos.
  v_won := (v_room.win_condition = 'score' AND v_max_score >= v_room.win_target)
        OR (v_room.win_condition = 'rounds' AND v_room.current_round >= v_room.win_target);

  IF v_won THEN
    UPDATE public.rooms SET status = 'finished', round_phase_ends_at = NULL WHERE id = p_room_id;
    RETURN jsonb_build_object('action', 'finished');
  END IF;

  SELECT min(coordinator_count) INTO v_min_count
  FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL AND id <> COALESCE(v_room.current_coordinator, '');
  IF v_min_count IS NULL THEN
    SELECT min(coordinator_count) INTO v_min_count
    FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL;
  END IF;

  SELECT id INTO v_next_coordinator FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count = v_min_count
    AND id <> COALESCE(v_room.current_coordinator, '')
  ORDER BY random() LIMIT 1;
  IF v_next_coordinator IS NULL THEN
    SELECT id INTO v_next_coordinator FROM public.players
    WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count = v_min_count
    ORDER BY random() LIMIT 1;
  END IF;

  UPDATE public.rooms
  SET status = 'choosing',
      current_round = v_room.current_round + 1,
      current_coordinator = v_next_coordinator,
      current_word_id = NULL,
      round_phase_ends_at = now() + make_interval(secs => public.phase_secs(p_room_id, 60)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('action', 'next_round', 'coordinator', v_next_coordinator);
END;
$function$;

-- ===== extend_writing_or_advance: prorrogações escalam =====
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
  v_extension_seconds int := 0;
  v_kicked text[] := ARRAY[]::text[];
  v_extended_players text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;

  IF v_room.round_phase_ends_at IS NOT NULL
     AND v_room.round_phase_ends_at > now() - interval '2 seconds' THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

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
      AND p.kicked_at IS NULL
      AND p.id <> COALESCE(v_room.current_coordinator, '')
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
            writing_extensions = writing_extensions + 1,
            is_connected = true
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt, phase)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.writing_extensions + 1, 'writing')
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
      v_extension_seconds := GREATEST(
        v_extension_seconds,
        CASE WHEN v_pending.writing_extensions = 0 THEN 20 ELSE 15 END
      );
    ELSE
      UPDATE public.players
        SET kicked_at = now(),
            is_connected = false
        WHERE id = v_pending.id;
      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    v_extension_seconds := public.phase_secs(p_room_id, v_extension_seconds);
    UPDATE public.rooms
      SET round_phase_ends_at = now() + make_interval(secs => v_extension_seconds),
          phase_started_at = now()
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'seconds', v_extension_seconds,
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

-- ===== extend_voting_or_advance: prorrogações escalam =====
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
  v_extension_seconds int := 0;
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
            voting_extensions = voting_extensions + 1,
            is_connected = true
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt, phase)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.voting_extensions + 1, 'voting')
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
      v_extension_seconds := GREATEST(
        v_extension_seconds,
        CASE WHEN v_pending.voting_extensions = 0 THEN 20 ELSE 15 END
      );
    ELSE
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            voting_extensions = voting_extensions + 1,
            kicked_at = now(),
            is_connected = false
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt, phase)
      VALUES (p_room_id, v_room.current_round, v_pending.id, 3, 'voting')
      ON CONFLICT DO NOTHING;

      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    v_extension_seconds := public.phase_secs(p_room_id, v_extension_seconds);
    UPDATE public.rooms
      SET round_phase_ends_at = now() + make_interval(secs => v_extension_seconds),
          phase_started_at = now()
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'seconds', v_extension_seconds,
      'extended_players', to_jsonb(v_extended_players),
      'kicked', to_jsonb(v_kicked)
    );
  END IF;

  RETURN jsonb_build_object(
    'action', 'advanced',
    'kicked', to_jsonb(v_kicked)
  );
END;
$function$;
