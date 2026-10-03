-- =============================================================================
-- M1 · ROLLBACK FUNCIONAL (gerado por scripts/gen-m1-rollback.mjs — não editar)
-- Volta o comportamento pré-M1 das RPCs, do tick e do painel, remove os
-- objetos novos e reabre só o que o client pré-M1 usa (INSERT de bot em
-- players, UPDATE de rooms.host_id). NÃO reabre furos que nenhum client usava:
-- apply_similarity_bonus, insert_truth_definition, escrita direta em
-- definitions/rounds/reactions/room_words/round_extensions seguem fechados.
-- O espelho de privilégios da service_role (20261003090000) FICA: é o padrão
-- do Supabase e as edges dependem dele.
-- Ordem em produção (sem janela): m1_compat_old_client.sql → voltar o web
-- (wrangler rollback) → isto → supabase migration repair --status reverted.
-- Testado no CI dentro de uma transação (scripts/test-rollback.mjs).
-- =============================================================================

-- Lote H
DROP FUNCTION IF EXISTS public.get_client_config();

-- Lote F
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-ops-health') THEN
    PERFORM cron.unschedule('verbete-ops-health');
  END IF;
END $rb$;
DROP FUNCTION IF EXISTS public.ops_health_check();

-- tick_stalled_rooms ← 20260727180000_ops_observability.sql
CREATE OR REPLACE FUNCTION public.tick_stalled_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_count int := 0;
  v_clean jsonb;
BEGIN
  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'choosing'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_choosing_to_writing(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'writing'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.extend_writing_or_advance(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms WHERE status = 'shuffling'
  LOOP
    PERFORM public.advance_writing_to_voting(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'voting'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_voting_to_reveal(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT ro.id FROM public.rooms ro WHERE ro.status = 'reveal'
  LOOP
    PERFORM public.advance_reveal_to_scoreboard(r.id);
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'scoreboard'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_scoreboard_to_next_round_or_finished(r.id, false);
    v_count := v_count + 1;
  END LOOP;

  v_clean := public.cleanup_zombie_rooms();

  -- Fase 8: métrica de backstop + retenção dos eventos (30 dias)
  IF v_count > 0 THEN
    INSERT INTO public.ops_events (kind, payload)
    VALUES ('stalled_advance', jsonb_build_object('advanced', v_count));
  END IF;
  DELETE FROM public.ops_events WHERE at < now() - interval '30 days';

  RETURN jsonb_build_object('advanced', v_count, 'cleanup', v_clean, 'at', now());
END;
$function$;

-- admin_ops_summary ← 20260727180000_ops_observability.sql
CREATE OR REPLACE FUNCTION public.admin_ops_summary(p_hours int DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(hours => LEAST(GREATEST(p_hours, 1), 720));
  v_result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_build_object(
    'since', v_since,
    'funnel', jsonb_build_object(
      'rooms_created', (SELECT count(*) FROM public.rooms WHERE created_at > v_since),
      'games_started', (SELECT count(DISTINCT room_id) FROM public.rounds r
                        WHERE r.round = 1 AND r.scored_at > v_since),
      'rounds_played', (SELECT count(*) FROM public.rounds WHERE scored_at > v_since),
      'games_finished', (SELECT count(DISTINCT room_code) FROM public.match_history WHERE played_at > v_since),
      'daily_attempts', (SELECT count(*) FROM public.daily_attempts WHERE created_at > v_since)
    ),
    'health', jsonb_build_object(
      'client_errors', (SELECT count(*) FROM public.ops_events WHERE kind IN ('client_error','boundary_crash') AND at > v_since),
      'rpc_failures', (SELECT count(*) FROM public.ops_events WHERE kind = 'rpc_failure' AND at > v_since),
      'reconnects', (SELECT count(*) FROM public.ops_events WHERE kind = 'reconnect' AND at > v_since),
      'stalled_advances', (SELECT COALESCE(sum((payload->>'advanced')::int), 0)
                           FROM public.ops_events WHERE kind = 'stalled_advance' AND at > v_since),
      'sessions_with_errors', (SELECT count(DISTINCT session_key) FROM public.ops_events
                               WHERE kind IN ('client_error','boundary_crash') AND at > v_since)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- start_shuffling ← 20260711120000_server_authoritative_engine.sql
CREATE OR REPLACE FUNCTION public.start_shuffling(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.rooms SET status = 'shuffling'
  WHERE id = p_room_id AND status = 'writing'
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', v_id IS NOT NULL);
END;
$function$;

-- advance_writing_to_voting ← 20260727120000_scale_phase_times_large_rooms.sql
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

-- assert_actor_identity ← 20260722100000_fase1_identity_guards.sql
CREATE OR REPLACE FUNCTION public.assert_actor_identity(p_room_id uuid, p_actor_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_user_id uuid;
  v_is_bot boolean;
  v_found boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;  -- fallback sem sessão
  SELECT user_id, is_bot, true INTO v_user_id, v_is_bot, v_found
    FROM public.players WHERE id = p_actor_id AND room_id = p_room_id;
  IF NOT COALESCE(v_found, false) THEN RETURN 'actor_not_in_room'; END IF;
  IF COALESCE(v_is_bot, false) THEN RETURN 'actor_is_bot'; END IF;
  IF v_user_id IS NULL THEN RETURN NULL; END IF;  -- legado sem claim (residual)
  IF v_user_id <> v_uid THEN RETURN 'identity_mismatch'; END IF;
  RETURN NULL;
END;
$$;

-- guard_author_identity ← 20260722110000_fix_identity_trigger_field.sql
CREATE OR REPLACE FUNCTION public.guard_author_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_pid text;
  v_user_id uuid;
  v_is_bot boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;  -- cron/service/sem sessão
  v_pid := COALESCE(to_jsonb(NEW)->>'voter_id', to_jsonb(NEW)->>'player_id');
  IF v_pid IS NULL OR v_pid = '__truth__' THEN RETURN NEW; END IF;
  SELECT user_id, is_bot INTO v_user_id, v_is_bot FROM public.players WHERE id = v_pid;
  -- bot (orquestrado pelo host) ou linha inexistente (FK decide): libera
  IF v_is_bot IS DISTINCT FROM false THEN RETURN NEW; END IF;
  IF v_user_id IS NULL OR v_user_id = v_uid THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'votes' THEN
    RETURN NULL;  -- descarta a linha forjada sem abortar o lote (cast_votes_bulk)
  END IF;
  RAISE EXCEPTION 'identity_mismatch: % em %', v_pid, TG_TABLE_NAME;
END;
$$;

-- create_room_with_host ← 20260722100000_fase1_identity_guards.sql
CREATE OR REPLACE FUNCTION public.create_room_with_host(p_host_id text, p_nickname text, p_avatar text, p_color text)
RETURNS rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_code text;
  v_room public.rooms;
  v_attempts int := 0;
  v_uid uuid := auth.uid();
  v_claimed_by uuid;
BEGIN
  -- S4: impede que alguém "crie sala" com o player_id de outra pessoa —
  -- o ON CONFLICT abaixo moveria a vítima de sala.
  SELECT user_id INTO v_claimed_by FROM public.players WHERE id = p_host_id;
  IF v_claimed_by IS NOT NULL AND v_uid IS NOT NULL AND v_claimed_by <> v_uid THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  LOOP
    v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
    v_attempts := v_attempts + 1;
    IF v_attempts > 8 THEN
      RAISE EXCEPTION 'could not generate unique room code';
    END IF;
  END LOOP;

  INSERT INTO public.rooms (code, host_id, status)
  VALUES (v_code, p_host_id, 'lobby')
  RETURNING * INTO v_room;

  INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id)
  VALUES (p_host_id, v_room.id, p_nickname, p_avatar, p_color, v_uid)
  ON CONFLICT (id) DO UPDATE SET
    room_id = EXCLUDED.room_id,
    nickname = EXCLUDED.nickname,
    avatar = EXCLUDED.avatar,
    color = EXCLUDED.color,
    is_connected = true,
    user_id = COALESCE(public.players.user_id, EXCLUDED.user_id);

  RETURN v_room;
END;
$function$;

-- rejoin_room ← 20260722130000_voting_quorum_and_similarity.sql
CREATE OR REPLACE FUNCTION public.rejoin_room(p_code text, p_player_id text, p_nickname text, p_avatar text, p_color text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_existing public.players;
  v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RAISE EXCEPTION 'room_not_found';
  END IF;

  SELECT * INTO v_existing FROM public.players WHERE id = p_player_id AND room_id = v_room.id LIMIT 1;

  IF v_existing.id IS NOT NULL AND v_existing.user_id IS NOT NULL
     AND v_uid IS NOT NULL AND v_existing.user_id <> v_uid THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.players
      SET kicked_at = NULL,
          is_connected = true,
          writing_extensions = 0,
          voting_extensions = 0,
          user_id = COALESCE(v_existing.user_id, v_uid),
          -- Só quem foi EXPULSO e voltou é tratado como entrada tardia
          -- (sala 7850: reload/retomada de aba renovava joined_at e o
          -- jogador era dispensado da rodada — voto ignorado).
          joined_at = CASE
            WHEN v_existing.kicked_at IS NOT NULL
                 AND v_room.status IN ('writing','voting') THEN now()
            ELSE v_existing.joined_at
          END,
          nickname = COALESCE(NULLIF(p_nickname, ''), nickname),
          avatar = COALESCE(NULLIF(p_avatar, ''), avatar),
          color = COALESCE(NULLIF(p_color, ''), color)
      WHERE id = p_player_id;
  ELSE
    INSERT INTO public.players (id, room_id, nickname, avatar, color, is_connected, user_id)
    VALUES (p_player_id, v_room.id, p_nickname, p_avatar, p_color, true, v_uid);
  END IF;

  RETURN to_jsonb(v_room);
END;
$function$;

-- join_public_room ← 20260713130000_chat_public_rooms.sql
CREATE OR REPLACE FUNCTION public.join_public_room(
  p_player_id text,
  p_nickname text,
  p_avatar text,
  p_color text
) RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_code text;
  v_attempts int := 0;
BEGIN
  -- Bloqueia banidos (mesma checagem do fluxo de entrar com código)
  IF public.is_player_banned(p_player_id, auth.uid()) THEN
    RAISE EXCEPTION 'player_banned';
  END IF;

  -- Procura lobby público com vaga; SKIP LOCKED evita que dois jogadores
  -- em corrida travem um no outro (cada um pega um lobby diferente ou cria).
  SELECT r.* INTO v_room
  FROM public.rooms r
  WHERE r.visibility = 'public'
    AND r.status = 'lobby'
    AND (SELECT count(*) FROM public.players p WHERE p.room_id = r.id AND p.kicked_at IS NULL) < 12
  ORDER BY r.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_room IS NOT NULL THEN
    INSERT INTO public.players (id, room_id, nickname, avatar, color)
    VALUES (p_player_id, v_room.id, p_nickname, p_avatar, p_color)
    ON CONFLICT (id) DO UPDATE SET
      room_id = EXCLUDED.room_id,
      nickname = EXCLUDED.nickname,
      avatar = EXCLUDED.avatar,
      color = EXCLUDED.color,
      score = 0,
      coordinator_count = 0,
      writing_extensions = 0,
      voting_extensions = 0,
      kicked_at = NULL,
      is_connected = true;
    RETURN v_room;
  END IF;

  -- Nenhum lobby aberto: cria sala pública nova com o chamador como host
  LOOP
    v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
    v_attempts := v_attempts + 1;
    IF v_attempts > 8 THEN
      RAISE EXCEPTION 'could not generate unique room code';
    END IF;
  END LOOP;

  INSERT INTO public.rooms (code, host_id, status, visibility)
  VALUES (v_code, p_player_id, 'lobby', 'public')
  RETURNING * INTO v_room;

  INSERT INTO public.players (id, room_id, nickname, avatar, color)
  VALUES (p_player_id, v_room.id, p_nickname, p_avatar, p_color)
  ON CONFLICT (id) DO UPDATE SET
    room_id = EXCLUDED.room_id,
    nickname = EXCLUDED.nickname,
    avatar = EXCLUDED.avatar,
    color = EXCLUDED.color,
    score = 0,
    coordinator_count = 0,
    writing_extensions = 0,
    voting_extensions = 0,
    kicked_at = NULL,
    is_connected = true;

  RETURN v_room;
END;
$function$;

-- leave_room ← 20260607221241_9f8354cf-c9a6-49a8-a8c3-505ed0d9743d.sql
CREATE OR REPLACE FUNCTION public.leave_room(
  p_player_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player public.players;
  v_room public.rooms;
BEGIN
  IF p_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_player FROM public.players WHERE id = p_player_id LIMIT 1;
  IF v_player IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = v_player.room_id;

  -- No lobby (ou se a sala sumiu) podemos remover o registro;
  -- em qualquer fase ativa, só marcamos como desconectado p/ preservar histórico.
  IF v_room IS NULL OR v_room.status IN ('lobby','finished') THEN
    DELETE FROM public.players WHERE id = p_player_id;
  ELSE
    UPDATE public.players
       SET is_connected = false
     WHERE id = p_player_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- submit_definition ← 20260722130000_voting_quorum_and_similarity.sql
CREATE OR REPLACE FUNCTION public.submit_definition(p_room_id uuid, p_player_id text, p_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_clean text;
  v_norm text;
  v_id uuid;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL OR p_text IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  v_clean := substring(btrim(p_text) from 1 for 140);
  IF char_length(v_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_text');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  END IF;
  IF v_room.current_coordinator = p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'coordinator_cannot_write');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_player_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;

  v_norm := regexp_replace(lower(unaccent(v_clean)), '[^a-z0-9]+', ' ', 'g');

  -- Idêntica (normalizada)
  IF char_length(btrim(v_norm)) > 0 AND EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.player_id <> p_player_id
      AND regexp_replace(lower(unaccent(d.text)), '[^a-z0-9]+', ' ', 'g') = v_norm
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_definition');
  END IF;

  -- Muito parecida (playtest: IA/bots convergiam em textos quase iguais,
  -- ex.: "excesso de elegancia mundana" vs "excesso de elegancia formal")
  IF char_length(btrim(v_norm)) > 12 AND EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.player_id <> p_player_id
      AND similarity(
            regexp_replace(lower(unaccent(d.text)), '[^a-z0-9]+', ' ', 'g'),
            v_norm
          ) > 0.62
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_similar');
  END IF;

  INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
  VALUES (p_room_id, v_room.current_round, p_player_id, v_clean, false)
  ON CONFLICT (room_id, round, player_id)
    DO UPDATE SET text = EXCLUDED.text, created_at = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;

-- cast_vote ← 20260721140000_fix_vote_scoring_race.sql
CREATE OR REPLACE FUNCTION public.cast_vote(p_room_id uuid, p_voter_id text, p_definition_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_def public.definitions;
BEGIN
  IF p_room_id IS NULL OR p_voter_id IS NULL OR p_definition_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  -- Lock da sala: serializa com advance_voting_to_reveal/extends.
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'voting' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_voter_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;

  SELECT * INTO v_def FROM public.definitions WHERE id = p_definition_id;
  IF v_def IS NULL
     OR v_def.room_id <> p_room_id
     OR v_def.round <> v_room.current_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'definition_not_in_round');
  END IF;

  IF v_def.player_id = p_voter_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cannot_vote_own');
  END IF;

  INSERT INTO public.votes (room_id, round, voter_id, definition_id)
  VALUES (p_room_id, v_room.current_round, p_voter_id, p_definition_id)
  ON CONFLICT (room_id, round, voter_id)
    DO UPDATE SET definition_id = EXCLUDED.definition_id,
                  created_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- submit_bot_definitions_bulk ← 20260721130000_fix_reset_and_bot_dedup.sql
CREATE OR REPLACE FUNCTION public.submit_bot_definitions_bulk(p_room_id uuid, p_round integer, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_row jsonb;
  v_pid text;
  v_text text;
  v_norm text;
  v_inserted int := 0;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.status <> 'writing' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    v_pid := v_row->>'player_id';
    v_text := substring(btrim(COALESCE(v_row->>'text', '')) from 1 for 140);
    IF v_pid IS NULL OR char_length(v_text) = 0 THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.players
      WHERE id = v_pid AND room_id = p_room_id AND is_bot = true AND kicked_at IS NULL
    ) THEN CONTINUE; END IF;

    -- Dedup: pula se o texto normalizado já existe na rodada (humanos,
    -- outros bots ou a verdade) — antes a IA podia clonar o texto de um
    -- jogador e o duplicado entrava.
    v_norm := regexp_replace(lower(extensions.unaccent(v_text)), '[^a-z0-9]+', ' ', 'g');
    IF EXISTS (
      SELECT 1 FROM public.definitions d
      WHERE d.room_id = p_room_id AND d.round = p_round
        AND d.player_id <> v_pid
        AND regexp_replace(lower(extensions.unaccent(d.text)), '[^a-z0-9]+', ' ', 'g') = v_norm
    ) THEN CONTINUE; END IF;

    INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
    VALUES (p_room_id, p_round, v_pid, v_text, false)
    ON CONFLICT (room_id, round, player_id) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$function$;

-- cast_votes_bulk ← 20260721140000_fix_vote_scoring_race.sql
CREATE OR REPLACE FUNCTION public.cast_votes_bulk(p_room_id uuid, p_round integer, p_votes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_inserted int := 0;
  v_row jsonb;
  v_voter text;
  v_def_id uuid;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_votes, '[]'::jsonb))
  LOOP
    v_voter := v_row->>'voter_id';
    v_def_id := NULLIF(v_row->>'definition_id', '')::uuid;
    IF v_voter IS NULL OR v_def_id IS NULL THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.players
      WHERE id = v_voter AND room_id = p_room_id AND is_bot = true AND kicked_at IS NULL
    ) THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.definitions d
      WHERE d.id = v_def_id
        AND d.room_id = p_room_id
        AND d.round = p_round
        AND d.player_id <> v_voter
    ) THEN
      SELECT d.id INTO v_def_id
      FROM public.definitions d
      WHERE d.room_id = p_room_id
        AND d.round = p_round
        AND d.letter IS NOT NULL
        AND d.player_id <> v_voter
      ORDER BY random()
      LIMIT 1;
      IF v_def_id IS NULL THEN CONTINUE; END IF;
    END IF;

    INSERT INTO public.votes (room_id, round, voter_id, definition_id)
    VALUES (p_room_id, p_round, v_voter, v_def_id)
    ON CONFLICT (room_id, round, voter_id) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$function$;

-- record_match_result ← 20260720120000_fase1_stats_server_side.sql
CREATE OR REPLACE FUNCTION public.record_match_result(p_room_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_player public.players;
  v_position int;
  v_players_count int;
  v_truth_hits int;
  v_fooled int;
  v_won boolean;
  v_xp_gained int;
  v_stats public.user_stats;
  v_unlocked text[] := ARRAY[]::text[];
  v_code text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_room_code IS NULL OR char_length(p_room_code) NOT BETWEEN 3 AND 12 THEN
    RAISE EXCEPTION 'invalid room_code';
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE code = p_room_code;
  IF v_room IS NULL THEN RAISE EXCEPTION 'room not found'; END IF;
  -- Só partidas encerradas geram estatísticas (anti-replay/prematuro).
  IF v_room.status <> 'finished' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'match_not_finished');
  END IF;

  SELECT * INTO v_player FROM public.players
  WHERE room_id = v_room.id AND user_id = auth.uid() AND is_bot = false
  LIMIT 1;
  IF v_player IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_linked');
  END IF;

  -- Dedup definitivo por (user, sala)
  IF EXISTS (
    SELECT 1 FROM public.match_history
    WHERE user_id = auth.uid() AND room_code = p_room_code
  ) THEN
    RETURN jsonb_build_object('ok', true, 'deduped', true, 'xp_gained', 0, 'unlocked', '[]'::jsonb);
  END IF;

  -- Derivados 100% das tabelas oficiais
  SELECT count(*) INTO v_players_count FROM public.players WHERE room_id = v_room.id;
  SELECT 1 + count(*) INTO v_position FROM public.players
  WHERE room_id = v_room.id AND score > v_player.score;

  SELECT count(*) INTO v_truth_hits
  FROM public.votes v
  JOIN public.definitions d ON d.id = v.definition_id
  WHERE v.room_id = v_room.id AND v.voter_id = v_player.id AND d.is_truth = true;

  SELECT count(*) INTO v_fooled
  FROM public.votes v
  JOIN public.definitions d ON d.id = v.definition_id
  WHERE v.room_id = v_room.id AND d.player_id = v_player.id
    AND d.is_truth = false AND v.voter_id <> v_player.id;

  INSERT INTO public.user_stats (user_id) VALUES (auth.uid())
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.match_history (user_id, room_code, final_score, position, players_count)
  VALUES (auth.uid(), p_room_code, v_player.score, v_position, v_players_count);

  v_won := (v_position = 1);
  v_xp_gained := 20
    + (CASE WHEN v_won THEN 100 ELSE 0 END)
    + (v_truth_hits * 50)
    + (v_fooled * 30);

  UPDATE public.user_stats SET
    games_played = games_played + 1,
    games_won = games_won + (CASE WHEN v_won THEN 1 ELSE 0 END),
    total_score = total_score + v_player.score,
    best_match_score = GREATEST(best_match_score, v_player.score),
    rounds_coordinated = rounds_coordinated + v_player.coordinator_count,
    total_truth_hits = total_truth_hits + v_truth_hits,
    total_fooled = total_fooled + v_fooled,
    win_streak = (CASE WHEN v_won THEN win_streak + 1 ELSE 0 END),
    best_win_streak = GREATEST(best_win_streak, (CASE WHEN v_won THEN win_streak + 1 ELSE 0 END)),
    xp = xp + v_xp_gained,
    level = public.xp_to_level(xp + v_xp_gained),
    updated_at = now()
  WHERE user_id = auth.uid()
  RETURNING * INTO v_stats;

  FOR v_code IN
    SELECT code FROM (VALUES
      ('first_win',       v_stats.games_won >= 1),
      ('partidas_10',     v_stats.games_played >= 10),
      ('acertos_100',     v_stats.total_truth_hits >= 100),
      ('bluffs_100',      v_stats.total_fooled >= 100),
      ('invicto_3',       v_stats.win_streak >= 3),
      ('maior_enganador', v_fooled >= 5)
    ) AS checks(code, met)
    WHERE met
      AND EXISTS (SELECT 1 FROM public.achievements a WHERE a.code = checks.code)
      AND NOT EXISTS (
        SELECT 1 FROM public.user_achievements ua
        WHERE ua.user_id = auth.uid() AND ua.achievement_code = checks.code
      )
  LOOP
    INSERT INTO public.user_achievements (user_id, achievement_code)
    VALUES (auth.uid(), v_code)
    ON CONFLICT DO NOTHING;
    v_unlocked := array_append(v_unlocked, v_code);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'xp_gained', v_xp_gained,
    'xp_total', v_stats.xp,
    'level', v_stats.level,
    'unlocked', to_jsonb(v_unlocked)
  );
END;
$function$;

DROP TABLE IF EXISTS public.ops_alerts;
DROP TABLE IF EXISTS public.ops_heartbeat;

-- Lote A: objetos novos
DROP FUNCTION IF EXISTS public.migrate_host(uuid);
DROP FUNCTION IF EXISTS public.add_bot(uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.is_sessionless_api_call();

-- Caminhos de escrita que o client pré-M1 usa (bots e migração de host);
-- INSERT só nas colunas do addBot antigo (score/user_id seguem protegidos)
GRANT INSERT (id, room_id, nickname, avatar, color, is_bot) ON public.players TO anon, authenticated;
DROP POLICY IF EXISTS "players public insert" ON public.players;
CREATE POLICY "players public insert" ON public.players FOR INSERT TO public WITH CHECK (true);
GRANT UPDATE (host_id) ON public.rooms TO anon, authenticated;
DROP POLICY IF EXISTS "rooms public update" ON public.rooms;
CREATE POLICY "rooms public update" ON public.rooms FOR UPDATE TO public USING (true) WITH CHECK (true);

-- Privilégios padrão do Supabase
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
