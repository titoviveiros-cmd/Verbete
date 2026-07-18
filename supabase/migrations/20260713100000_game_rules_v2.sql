-- ============================================================
-- Regras de jogo v2 (especificação Verbete)
--
-- 1) Pontuação em escala de centenas (spec: +100 acerto, +50 por
--    jogador enganado). Conversão ~33x dos valores antigos:
--      acertar a verdade ........ +3  -> +100
--      cada voto no seu blefe ... +1  -> +50
--      bônus similaridade IA .... +3  -> +50
--      coordenador (ninguém achou a verdade) +2 -> +50
--      penalidade de prorrogação  -1  -> -25
-- 2) Tempos do spec: revelação 15s (backstop cron 20s), ranking 8s.
--    Votação já era 30s server-side.
-- 3) win_condition='rounds' passa a significar "N rodadas fixas"
--    (win_target = 5/10/15/20/custom), substituindo a regra antiga
--    de "todo mundo coordenou 2x".
-- 4) Guarda server-side contra voto na própria definição (spec:
--    "Votar na própria resposta: impossível") — antes só a UI impedia.
-- ============================================================

-- ---------- 1a) Pontuação-base: advance_voting_to_reveal ----------
CREATE OR REPLACE FUNCTION public.advance_voting_to_reveal(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_truth_def_id uuid;
  v_truth_voters int;
  v_total_votes int;
  v_defs_count int;
  v_inserted boolean := false;
  r record;
  v_base_url text;
  v_anon_key text;
  v_candidates jsonb;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' THEN RETURN; END IF;

  SELECT count(*) INTO v_total_votes FROM public.votes
  WHERE room_id = p_room_id AND round = v_room.current_round;
  SELECT count(*) INTO v_defs_count FROM public.definitions
  WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = false AND player_id <> '__truth__';

  IF v_total_votes = 0 AND v_defs_count > 0 AND (
       v_room.round_phase_ends_at IS NULL
       OR v_room.round_phase_ends_at > now() - interval '90 seconds'
     ) THEN
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.rounds (room_id, round, coordinator_id, word_id)
    VALUES (p_room_id, v_room.current_round, v_room.current_coordinator, v_room.current_word_id);
    v_inserted := true;
  EXCEPTION WHEN unique_violation THEN
    v_inserted := false;
  END;

  IF NOT v_inserted THEN
    UPDATE public.rooms SET status = 'reveal' WHERE id = p_room_id;
    RETURN;
  END IF;

  SELECT id INTO v_truth_def_id FROM public.definitions
  WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = true;

  SELECT count(*) INTO v_truth_voters FROM public.votes
  WHERE room_id = p_room_id AND round = v_room.current_round AND definition_id = v_truth_def_id;

  -- Acertou a definição verdadeira: +100
  IF v_truth_def_id IS NOT NULL THEN
    UPDATE public.players p SET score = p.score + 100
    WHERE p.id IN (
      SELECT voter_id FROM public.votes
      WHERE room_id = p_room_id AND round = v_room.current_round AND definition_id = v_truth_def_id
    );
  END IF;

  -- Cada jogador enganado pelo seu blefe: +50 por voto
  FOR r IN
    SELECT d.player_id, count(v.id) AS votes
    FROM public.definitions d
    LEFT JOIN public.votes v ON v.definition_id = d.id
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.is_truth = false AND d.player_id <> '__truth__'
    GROUP BY d.player_id
    HAVING count(v.id) > 0
  LOOP
    UPDATE public.players SET score = score + (r.votes * 50) WHERE id = r.player_id;
  END LOOP;

  -- Coordenador: +50 se ninguém achou a verdade
  IF v_truth_voters = 0 AND v_total_votes > 0 AND v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET score = score + 50 WHERE id = v_room.current_coordinator;
  END IF;

  IF v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET coordinator_count = coordinator_count + 1
    WHERE id = v_room.current_coordinator;
  END IF;

  UPDATE public.rooms SET status = 'reveal' WHERE id = p_room_id;

  BEGIN
    v_base_url := current_setting('app.settings.supabase_url', true);
    v_anon_key := current_setting('app.settings.supabase_anon_key', true);
    IF v_base_url IS NOT NULL AND v_anon_key IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('id', id, 'text', text))
        INTO v_candidates
      FROM public.definitions
      WHERE room_id = p_room_id AND round = v_room.current_round
        AND is_truth = false AND player_id <> '__truth__';

      IF v_candidates IS NOT NULL AND jsonb_array_length(v_candidates) > 0 THEN
        PERFORM net.http_post(
          url := v_base_url || '/functions/v1/score-similarity',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_anon_key
          ),
          body := jsonb_build_object(
            'room_id', p_room_id,
            'round', v_room.current_round,
            'candidates', v_candidates
          )
        );
      END IF;
    ELSE
      RAISE WARNING 'advance_voting_to_reveal: app.settings.supabase_url/supabase_anon_key não configurados — bônus de similaridade pulado nesta rodada';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'advance_voting_to_reveal: falha ao chamar score-similarity via pg_net: %', SQLERRM;
  END;
END;
$function$;

-- ---------- 1b) Bônus de similaridade: +50 ----------
CREATE OR REPLACE FUNCTION public.apply_similarity_bonus(p_definition_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF p_definition_ids IS NULL OR array_length(p_definition_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'bumped', 0);
  END IF;

  UPDATE public.definitions SET near_truth = true
  WHERE id = ANY(p_definition_ids) AND near_truth IS DISTINCT FROM true;

  WITH bumped AS (
    UPDATE public.players p
    SET score = p.score + 50
    FROM public.definitions d
    WHERE d.id = ANY(p_definition_ids) AND d.player_id = p.id
    RETURNING p.id
  )
  SELECT count(*) INTO v_count FROM bumped;

  RETURN jsonb_build_object('ok', true, 'bumped', v_count);
END;
$function$;

-- ---------- 1c) Penalidade de prorrogação: -25 ----------
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
        SET score = GREATEST(score - 25, 0),
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
        SET score = GREATEST(score - 25, 0),
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
        SET score = GREATEST(score - 25, 0),
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

-- ---------- 1d) Trigger de guarda da fase writing: -25 ----------
CREATE OR REPLACE FUNCTION public.guard_writing_phase_advance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pending record;
  v_has_pending boolean := false;
  v_extended boolean := false;
  v_now timestamptz := now();
BEGIN
  IF OLD.status = 'writing'
     AND NEW.status IN ('shuffling', 'voting')
     AND NEW.current_round = OLD.current_round THEN

    FOR v_pending IN
      SELECT p.id, p.writing_extensions
      FROM public.players p
      WHERE p.room_id = OLD.id
        AND p.is_bot = false
        AND p.kicked_at IS NULL
        AND p.id <> COALESCE(OLD.current_coordinator, '')
        AND (OLD.phase_started_at IS NULL OR p.joined_at <= OLD.phase_started_at + interval '3 seconds')
        AND NOT EXISTS (
          SELECT 1
          FROM public.definitions d
          WHERE d.room_id = OLD.id
            AND d.round = OLD.current_round
            AND d.player_id = p.id
        )
    LOOP
      v_has_pending := true;

      IF OLD.round_phase_ends_at IS NOT NULL
         AND OLD.round_phase_ends_at <= v_now THEN
        IF v_pending.writing_extensions < 2 THEN
          UPDATE public.players
          SET score = GREATEST(score - 25, 0),
              writing_extensions = writing_extensions + 1,
              is_connected = true
          WHERE id = v_pending.id;

          INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
          VALUES (OLD.id, OLD.current_round, v_pending.id, v_pending.writing_extensions + 1)
          ON CONFLICT DO NOTHING;

          v_extended := true;
        ELSE
          UPDATE public.players
          SET score = GREATEST(score - 25, 0),
              kicked_at = v_now,
              is_connected = false
          WHERE id = v_pending.id;
        END IF;
      END IF;
    END LOOP;

    IF v_has_pending THEN
      NEW.status := 'writing';
      NEW.current_round := OLD.current_round;
      NEW.current_word_id := OLD.current_word_id;
      NEW.current_coordinator := OLD.current_coordinator;
      NEW.used_word_ids := OLD.used_word_ids;
      NEW.phase_started_at := CASE WHEN v_extended THEN v_now ELSE OLD.phase_started_at END;
      NEW.round_phase_ends_at := CASE WHEN v_extended THEN v_now + interval '20 seconds' ELSE OLD.round_phase_ends_at END;
      RETURN NEW;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------- 2a) Revelação: 15s no client, backstop do cron em 20s ----------
CREATE OR REPLACE FUNCTION public.advance_reveal_to_scoreboard(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_scored_at timestamptz;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'reveal' THEN RETURN; END IF;
  SELECT scored_at INTO v_scored_at FROM public.rounds
  WHERE room_id = p_room_id AND round = v_room.current_round LIMIT 1;
  -- Cliente exibe contagem regressiva de 15s no reveal. O watchdog só age
  -- como rede de segurança caso o host trave: aguarda 20s antes de avançar.
  IF v_scored_at IS NULL OR v_scored_at > now() - interval '20 seconds' THEN RETURN; END IF;
  UPDATE public.rooms SET status = 'scoreboard' WHERE id = p_room_id;
END;
$function$;

-- ---------- 2b) Ranking: hold de 8s ----------
CREATE OR REPLACE FUNCTION public.finish_reveal(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_max_score int;
  v_status text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'reveal' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
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

  v_status := CASE
    WHEN v_room.win_condition = 'score' AND v_max_score >= v_room.win_target THEN 'finished'
    ELSE 'scoreboard'
  END;

  UPDATE public.rooms
  SET status = v_status,
      round_phase_ends_at = CASE WHEN v_status = 'scoreboard' THEN now() + interval '8 seconds' ELSE NULL END
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$function$;

-- ---------- 3) Rodadas fixas: win_condition='rounds' = N rodadas ----------
CREATE OR REPLACE FUNCTION public.advance_scoreboard_to_next_round_or_finished(
  p_room_id uuid,
  p_force boolean DEFAULT false
) RETURNS jsonb
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
      round_phase_ends_at = now() + interval '60 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('action', 'next_round', 'coordinator', v_next_coordinator);
END;
$function$;

-- Default de sala nova: 10 rodadas (antes win_target=20, que era alvo de
-- pontos herdado; em modo 'rounds' v2 significa 10 rodadas fixas).
ALTER TABLE public.rooms ALTER COLUMN win_target SET DEFAULT 10;

-- ---------- 4) Impossível votar na própria definição ----------
CREATE OR REPLACE FUNCTION public.guard_no_self_vote()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.id = NEW.definition_id AND d.player_id = NEW.voter_id
  ) THEN
    RAISE EXCEPTION 'self_vote_not_allowed';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_no_self_vote_trigger ON public.votes;
CREATE TRIGGER guard_no_self_vote_trigger
BEFORE INSERT ON public.votes
FOR EACH ROW
EXECUTE FUNCTION public.guard_no_self_vote();
