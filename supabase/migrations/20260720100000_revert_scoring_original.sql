-- ============================================================
-- AJUSTE FUNDAMENTAL (Verbete 2.0): reverte a pontuação
-- integralmente à regra ORIGINAL do jogo:
--
--   acertar a definição verdadeira ............ +3
--   cada voto recebido no seu blefe ........... +1
--   blefe >=80% equivalente à verdade (IA) .... +3
--   coordenador quando ninguém acha a verdade . +2
--   penalidade de prorrogação ................. -1 (piso 0)
--
-- Nada mais muda: rodadas fixas, timers, XP, conquistas e o fluxo
-- de fases permanecem como estão. A partir desta migration a fórmula
-- fica CONGELADA (critério de aceite 17 do plano v2.0).
--
-- ROLLBACK: reaplicar os corpos de 20260713100000_game_rules_v2.sql
-- (valores +100/+50/+50/-25) — as definições completas estão lá.
-- ============================================================

-- ---------- advance_voting_to_reveal: pontuação-base original ----------
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

  -- Acertou a definição verdadeira: +3
  IF v_truth_def_id IS NOT NULL THEN
    UPDATE public.players p SET score = p.score + 3
    WHERE p.id IN (
      SELECT voter_id FROM public.votes
      WHERE room_id = p_room_id AND round = v_room.current_round AND definition_id = v_truth_def_id
    );
  END IF;

  -- Cada voto no seu blefe: +1 por voto
  FOR r IN
    SELECT d.player_id, count(v.id) AS votes
    FROM public.definitions d
    LEFT JOIN public.votes v ON v.definition_id = d.id
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.is_truth = false AND d.player_id <> '__truth__'
    GROUP BY d.player_id
    HAVING count(v.id) > 0
  LOOP
    UPDATE public.players SET score = score + r.votes WHERE id = r.player_id;
  END LOOP;

  -- Coordenador: +2 se ninguém achou a verdade (e houve votos)
  IF v_truth_voters = 0 AND v_total_votes > 0 AND v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET score = score + 2 WHERE id = v_room.current_coordinator;
  END IF;

  IF v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET coordinator_count = coordinator_count + 1
    WHERE id = v_room.current_coordinator;
  END IF;

  UPDATE public.rooms SET status = 'reveal' WHERE id = p_room_id;

  BEGIN
    v_base_url := public.get_app_config('supabase_url');
    v_anon_key := public.get_app_config('supabase_anon_key');
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
      RAISE WARNING 'advance_voting_to_reveal: app_config supabase_url/supabase_anon_key ausentes — bônus de similaridade pulado nesta rodada';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'advance_voting_to_reveal: falha ao chamar score-similarity via pg_net: %', SQLERRM;
  END;
END;
$function$;

-- ---------- Bônus de similaridade: +3 ----------
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
    SET score = p.score + 3
    FROM public.definitions d
    WHERE d.id = ANY(p_definition_ids) AND d.player_id = p.id
    RETURNING p.id
  )
  SELECT count(*) INTO v_count FROM bumped;

  RETURN jsonb_build_object('ok', true, 'bumped', v_count);
END;
$function$;

-- ---------- Penalidade de prorrogação: -1 (piso 0) ----------
-- Corpos idênticos aos atuais, trocando apenas GREATEST(score-25,0)
-- por GREATEST(score-1,0).
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

-- ---------- Trigger de guarda: -1 ----------
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
          SET score = GREATEST(score - 1, 0),
              writing_extensions = writing_extensions + 1,
              is_connected = true
          WHERE id = v_pending.id;

          INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
          VALUES (OLD.id, OLD.current_round, v_pending.id, v_pending.writing_extensions + 1)
          ON CONFLICT DO NOTHING;

          v_extended := true;
        ELSE
          UPDATE public.players
          SET score = GREATEST(score - 1, 0),
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
