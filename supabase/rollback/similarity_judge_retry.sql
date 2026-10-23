-- ROLLBACK de 20261021190000_similarity_judge_retry.sql: o juiz volta a
-- rodar uma vez só (disparo direto no advance_voting_to_reveal).
--   npx supabase db query --linked -f supabase/rollback/similarity_judge_retry.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-judge-retry') THEN
    PERFORM cron.unschedule('verbete-judge-retry');
  END IF;
END $$;

-- advance_voting_to_reveal ← 20260722130000
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

  -- QUÓRUM REAL (sala 7850): humano vivo sem voto + prazo ainda válido
  -- (+2s de folga p/ latência móvel) → não avança. Nenhum bug de client
  -- consegue mais pontuar a rodada sem o voto de alguém dentro do tempo.
  IF v_room.round_phase_ends_at IS NOT NULL
     AND now() < v_room.round_phase_ends_at + interval '2 seconds'
     AND EXISTS (
       SELECT 1 FROM public.players p
       WHERE p.room_id = p_room_id AND p.kicked_at IS NULL AND p.is_bot = false
         AND NOT EXISTS (
           SELECT 1 FROM public.votes v
           WHERE v.room_id = p_room_id
             AND v.round = v_room.current_round
             AND v.voter_id = p.id
         )
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

-- apply_similarity_bonus ← 20260729120000 (sem a trava de partida encerrada)
CREATE OR REPLACE FUNCTION public.apply_similarity_bonus(p_room_id uuid, p_round integer, p_definition_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF p_room_id IS NULL OR p_round IS NULL
     OR p_definition_ids IS NULL OR array_length(p_definition_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'bumped', 0);
  END IF;

  -- Atômico: quem NÃO estava near_truth vira near_truth AGORA e é o único
  -- que pontua. Replays acham near_truth=true e não retornam linhas.
  WITH marked AS (
    UPDATE public.definitions d
    SET near_truth = true
    WHERE d.id = ANY(p_definition_ids)
      AND d.room_id = p_room_id
      AND d.round = p_round
      AND d.is_truth = false
      AND d.player_id <> '__truth__'
      AND d.near_truth IS DISTINCT FROM true
    RETURNING d.player_id
  ),
  por_jogador AS (
    SELECT player_id, count(*) AS n FROM marked GROUP BY player_id
  ),
  bumped AS (
    UPDATE public.players p
    SET score = p.score + 3 * pj.n
    FROM por_jogador pj
    WHERE p.id = pj.player_id AND p.room_id = p_room_id
    RETURNING p.id
  )
  SELECT count(*) INTO v_count FROM bumped;

  RETURN jsonb_build_object('ok', true, 'bumped', v_count);
END;
$function$;

DROP FUNCTION IF EXISTS public.retry_round_judgments();
DROP FUNCTION IF EXISTS public.fire_round_judge(uuid, int);
ALTER TABLE public.rounds
  DROP COLUMN IF EXISTS judge_request_id,
  DROP COLUMN IF EXISTS judge_fired_at,
  DROP COLUMN IF EXISTS judge_attempts,
  DROP COLUMN IF EXISTS judged_at;
