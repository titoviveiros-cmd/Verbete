-- =============================================================================
-- 🧠 Bônus de definição próxima: o juiz ganha 2ª e 3ª chance (2026-10-21).
--
-- Auditoria (caso CONTUMAZ, sala 9591): o juiz roda UMA vez por rodada, no
-- advance_voting_to_reveal, por pg_net — sem nova tentativa, sem marca de
-- "julgado" e com o prazo padrão de 5 s do pg_net (a edge pode levar até
-- ~17 s: 2 tentativas de 8 s). Falha transitória (429, timeout, rede) ou o
-- RPC do bônus falhando = +3 aprovado perdido em silêncio. (O CONTUMAZ em si
-- NÃO foi isso: o juiz respondeu e deu 35 < 80.)
--
-- Agora: fire_round_judge dispara com prazo de 20 s e guarda o id da
-- requisição na rodada; retry_round_judgments (cron a cada minuto) lê a
-- resposta em net._http_response — 200 sem "error" → rounds.judged_at;
-- timeout, HTTP≠200, "error" (IA fora, 'apply_failed') ou resposta sumida →
-- dispara de novo, até 3 tentativas, só nos primeiros 15 min; na 3ª falha
-- desiste e registra 'judge_gave_up'. A soma do bônus segue idempotente
-- (apply_similarity_bonus): reenvio nunca soma duas vezes. Valor (+3) e
-- limiar (80) intocados.
--
-- Compatível com o cliente em produção (nada muda para ele) e com a edge
-- antiga. Fica para aplicar junto com o merge.
-- ROLLBACK: supabase/rollback/similarity_judge_retry.sql
-- =============================================================================

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS judge_request_id bigint,
  ADD COLUMN IF NOT EXISTS judge_fired_at timestamptz,
  ADD COLUMN IF NOT EXISTS judge_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS judged_at timestamptz;

CREATE OR REPLACE FUNCTION public.fire_round_judge(p_room_id uuid, p_round int)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_base_url text := public.get_app_config('supabase_url');
  v_anon_key text := public.get_app_config('supabase_anon_key');
  v_candidates jsonb;
  v_req bigint;
BEGIN
  IF v_base_url IS NULL OR v_anon_key IS NULL THEN
    RAISE WARNING 'fire_round_judge: app_config supabase_url/supabase_anon_key ausentes — bônus de similaridade pulado nesta rodada';
    RETURN NULL;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', id, 'text', text))
    INTO v_candidates
    FROM public.definitions
   WHERE room_id = p_room_id AND round = p_round
     AND is_truth = false AND player_id <> '__truth__';

  IF v_candidates IS NULL OR jsonb_array_length(v_candidates) = 0 THEN
    UPDATE public.rounds SET judged_at = now() WHERE room_id = p_room_id AND round = p_round;
    RETURN NULL;  -- nada a julgar
  END IF;

  SELECT net.http_post(
    url := v_base_url || '/functions/v1/score-similarity',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon_key
    ),
    body := jsonb_build_object(
      'room_id', p_room_id,
      'round', p_round,
      'candidates', v_candidates
    ),
    timeout_milliseconds := 20000
  ) INTO v_req;

  UPDATE public.rounds
     SET judge_request_id = v_req,
         judge_fired_at = now(),
         judge_attempts = judge_attempts + 1
   WHERE room_id = p_room_id AND round = p_round;
  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.fire_round_judge(uuid, int) FROM PUBLIC, anon, authenticated;

-- advance_voting_to_reveal: corpo de 20260722130000 com o disparo trocado
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

  -- 🧠 (2026-10-21): o disparo foi para fire_round_judge — prazo de 20 s no
  -- pg_net (o padrão de 5 s cortava a edge, que pode levar até ~17 s) e o id
  -- da requisição guardado na rodada para o reenvio (retry_round_judgments).
  BEGIN
    PERFORM public.fire_round_judge(p_room_id, v_room.current_round);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'advance_voting_to_reveal: falha ao chamar score-similarity via pg_net: %', SQLERRM;
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.retry_round_judgments()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_found boolean;
  v_status int;
  v_timed_out boolean;
  v_content text;
  v_err text;
  v_done int := 0;
  v_retried int := 0;
  v_gave_up int := 0;
BEGIN
  FOR r IN
    SELECT x.room_id, x.round, x.judge_request_id, x.judge_fired_at, x.judge_attempts,
           (ro.status IS NOT DISTINCT FROM 'finished') AS room_finished,
           EXISTS (
             SELECT 1 FROM public.definitions d
              WHERE d.room_id = x.room_id AND d.round = x.round AND d.near_truth
           ) AS bonus_applied
      FROM public.rounds x
      JOIN public.rooms ro ON ro.id = x.room_id
     WHERE x.judged_at IS NULL
       AND x.judge_attempts BETWEEN 0 AND 3
       AND x.scored_at > now() - interval '15 minutes'
       AND x.scored_at < now() - interval '25 seconds'
       AND COALESCE(x.judge_fired_at, x.scored_at) < now() - interval '25 seconds'
  LOOP
    -- Bônus já gravado nesta rodada = o juiz respondeu (talvez depois do
    -- prazo do pg_net): reenviar poderia premiar OUTRA definição.
    IF r.bonus_applied THEN
      UPDATE public.rounds SET judged_at = now() WHERE room_id = r.room_id AND round = r.round;
      v_done := v_done + 1;
      CONTINUE;
    END IF;
    -- Partida encerrada: o pódio e o XP já foram gravados — um +3 tardio
    -- reordenaria o pódio depois do pagamento. Desiste sem reenviar.
    IF r.room_finished THEN
      UPDATE public.rounds SET judge_attempts = 4 WHERE room_id = r.room_id AND round = r.round;
      INSERT INTO public.ops_events (kind, payload)
      VALUES ('judge_gave_up', jsonb_build_object('room_id', r.room_id, 'round', r.round, 'reason', 'room_finished'));
      v_gave_up := v_gave_up + 1;
      CONTINUE;
    END IF;
    -- Primeiro disparo que nem chegou a sair (falha antes de contar a tentativa)
    IF r.judge_attempts = 0 THEN
      PERFORM public.fire_round_judge(r.room_id, r.round);
      v_retried := v_retried + 1;
      CONTINUE;
    END IF;
    v_found := false;
    v_err := NULL;
    SELECT true, status_code, timed_out, content
      INTO v_found, v_status, v_timed_out, v_content
      FROM net._http_response WHERE id = r.judge_request_id;
    IF COALESCE(v_found, false) THEN
      BEGIN
        v_err := (v_content::jsonb) ->> 'error';
      EXCEPTION WHEN OTHERS THEN
        v_err := 'invalid_body';
      END;
    END IF;

    IF COALESCE(v_found, false) AND v_status = 200
       AND NOT COALESCE(v_timed_out, false) AND v_err IS NULL THEN
      UPDATE public.rounds SET judged_at = now() WHERE room_id = r.room_id AND round = r.round;
      v_done := v_done + 1;
    ELSIF COALESCE(v_found, false) OR r.judge_fired_at < now() - interval '60 seconds' THEN
      -- falhou (timeout, HTTP≠200, erro da IA, bônus não gravado) ou a
      -- resposta sumiu: nova tentativa; na 3ª falha desiste e avisa
      IF r.judge_attempts < 3 THEN
        PERFORM public.fire_round_judge(r.room_id, r.round);
        v_retried := v_retried + 1;
      ELSE
        UPDATE public.rounds SET judge_attempts = 4 WHERE room_id = r.room_id AND round = r.round;
        INSERT INTO public.ops_events (kind, payload)
        VALUES ('judge_gave_up', jsonb_build_object(
          'room_id', r.room_id, 'round', r.round,
          'status', v_status, 'timed_out', v_timed_out, 'error', v_err
        ));
        v_gave_up := v_gave_up + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('judged', v_done, 'retried', v_retried, 'gave_up', v_gave_up);
END;
$$;

REVOKE ALL ON FUNCTION public.retry_round_judgments() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-judge-retry') THEN
    PERFORM cron.unschedule('verbete-judge-retry');
  END IF;
END $$;

SELECT cron.schedule(
  'verbete-judge-retry',
  '* * * * *',
  $$SELECT public.retry_round_judgments();$$
);
