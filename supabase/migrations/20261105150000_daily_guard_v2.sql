-- =============================================================================
-- V2 — Desafio Diário: reserva atômica ANTES da IA (05/11/2026)
-- Projeto: verbete-piloto-ia/PROJETO-SEGURANCA-IA-V1-V2-V3.md (frente V2).
--
-- Problema (master b7ee8d1): submitDailyAttempt chama a IA ANTES de saber se o
-- jogador já jogou na hora; o "already_played" só vem do RPC, depois. Reenvio,
-- duplo toque ou script = uma chamada paga (ou cota gratuita) a cada vez.
--
-- O que esta migration faz (NÃO muda pontuação, streak, conquistas nem
-- submit_daily_attempt_scored, que continua sendo a última barreira):
--   * daily_eval_claims: uma reserva por (usuário, hora), com claim_id.
--   * daily_claim(): decide ANTES da IA (já jogou / em andamento / limites /
--     disjuntor) e reserva atomicamente.
--   * daily_finish_ok(): só o claim vigente registra (resposta atrasada não
--     sobrescreve), na MESMA transação de submit_daily_attempt_scored.
--   * daily_finish_fail(): falha não gasta a tentativa; separa falha do
--     provedor (conta no disjuntor global) de falha nossa de gravação.
--   * ai_quota: contadores atômicos por janela (reutilizável pela V3).
--   * Modo em app_config.daily_guard_mode:
--       'desligado' → fluxo antigo (interruptor de rollback);
--       'observar'  → (PADRÃO) decide e REGISTRA o que bloquearia, mas não bloqueia;
--       'aplicar'   → bloqueia.
--   * Telemetria em ops_events (kind 'daily_guard'): SEM usuário, palpite,
--     palavra ou definição.
-- Acesso: só service_role (o Worker). Nenhuma função é chamável por anon/authenticated.
-- ROLLBACK: supabase/rollback/daily_guard_v2.sql — EXIGE o Worker anterior no ar antes
--   (o Worker novo chama daily_claim mesmo no modo 'desligado'). 'desligado' é a
--   alternativa AO script, não um pré-requisito dele.
-- Revisão Red Team (05/11): trava consultiva por usuário/hora (M1), FOUND em vez de
--   IS NOT NULL na linha (M2), disjuntor só com falhas transitórias e 1 por jogador/hora (A3),
--   hora calculada no banco (B1), mínimos seguros de configuração (B5).
-- =============================================================================

-- 1) Tabelas -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_eval_claims (
  user_id           uuid        NOT NULL,
  challenge_hour    timestamptz NOT NULL,
  claim_id          uuid        NOT NULL,
  state             text        NOT NULL CHECK (state IN ('running', 'done', 'failed')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  failures          integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_failure_at   timestamptz,
  last_failure_kind text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, challenge_hour),
  CONSTRAINT daily_eval_claims_hour_trunc CHECK (challenge_hour = date_trunc('hour', challenge_hour))
);
CREATE INDEX IF NOT EXISTS daily_eval_claims_updated_idx ON public.daily_eval_claims (updated_at);
ALTER TABLE public.daily_eval_claims ENABLE ROW LEVEL SECURITY;  -- sem policies: só service_role
REVOKE ALL ON public.daily_eval_claims FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.ai_quota (
  key          text        NOT NULL,
  window_start timestamptz NOT NULL,
  used         integer     NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (key, window_start)
);
ALTER TABLE public.ai_quota ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_quota FROM PUBLIC, anon, authenticated;

-- 2) Configuração (valores PROPOSTOS; só ajustáveis com autorização) ------------
INSERT INTO public.app_config (key, value) VALUES
  ('daily_guard_mode', 'observar'),
  ('daily_guard_claim_ttl_s', '45'),               -- > prazo do Diário (15 s de IA) + banco
  ('daily_guard_user_fail_max', '3'),              -- falhas do PROVEDOR seguidas por usuário/hora…
  ('daily_guard_user_fail_cooldown_s', '120'),     -- …antes de uma pausa (a tentativa nunca é gasta)
  ('daily_guard_user_evals_per_day', '48'),        -- avaliações (sucessos + falhas) por usuário/dia (24 horas + folga)
  ('daily_guard_origin_evals_per_hour', '60'),     -- por origem (só se o Worker enviar uma)
  ('daily_guard_breaker_fail_threshold', '10'),    -- falhas do provedor (todos) na janela…
  ('daily_guard_breaker_window_s', '300')          -- …abrem o disjuntor até a janela virar
ON CONFLICT (key) DO NOTHING;

-- inteiro de app_config com padrão seguro (valor ausente ou inválido = padrão)
CREATE OR REPLACE FUNCTION public.daily_guard_int(p_key text, p_default integer, p_min integer DEFAULT 1)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v text := public.get_app_config(p_key);
BEGIN
  IF v ~ '^\d{1,9}$' THEN RETURN greatest(v::integer, p_min); END IF;  -- B5: nunca abaixo do mínimo seguro
  RETURN greatest(p_default, p_min);
END $$;

CREATE OR REPLACE FUNCTION public.daily_guard_mode()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v text := public.get_app_config('daily_guard_mode');
BEGIN
  IF v IN ('desligado', 'observar', 'aplicar') THEN RETURN v; END IF;
  RETURN 'observar';  -- valor ausente ou inválido nunca vira 'aplicar'
END $$;

-- 3) Cota atômica por janela ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_quota_used(p_key text, p_window_s integer)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT coalesce((SELECT used FROM public.ai_quota
                    WHERE key = p_key
                      AND window_start = to_timestamp(floor(extract(epoch FROM now()) / p_window_s) * p_window_s)), 0)
$$;

CREATE OR REPLACE FUNCTION public.ai_quota_add(p_key text, p_window_s integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_used integer;
BEGIN
  INSERT INTO public.ai_quota AS q (key, window_start, used)
  VALUES (p_key, to_timestamp(floor(extract(epoch FROM now()) / p_window_s) * p_window_s), 1)
  ON CONFLICT (key, window_start) DO UPDATE SET used = q.used + 1
  RETURNING used INTO v_used;          -- atômico mesmo com pedidos simultâneos
  RETURN v_used;
END $$;

-- 4) Telemetria (nunca derruba a operação; nada pessoal) -------------------------
CREATE OR REPLACE FUNCTION public.daily_guard_log(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.ops_events (kind, payload) VALUES ('daily_guard', p_payload);
EXCEPTION WHEN OTHERS THEN
  NULL;  -- telemetria nunca bloqueia o jogador
END $$;

-- 5) Reserva ANTES da IA ---------------------------------------------------------
-- Retorno (jsonb):
-- A hora do desafio é a do BANCO (date_trunc('hour', now())) e volta em 'hour';
-- p_hour do Worker é só conferência (relógio diferente na virada → usa a do banco).
--   {status:'bypass', mode:'desligado'}                       → Worker usa o fluxo antigo
--   {status:'claimed', claim_id, mode, would_block}            → pode chamar a IA
--   {status:'pass_no_claim', mode:'observar', would_block}     → observar sem reserva possível: fluxo antigo
--   modo aplicar, SEM IA:
--   {status:'already_played', attempt}  (mesmo formato do submit_daily_attempt_scored)
--   {status:'in_progress'} · {status:'cooldown'} · {status:'rate_limited'} · {status:'provider_unavailable'}
CREATE OR REPLACE FUNCTION public.daily_claim(p_user_id uuid, p_hour timestamptz DEFAULT NULL, p_origin text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_mode      text := public.daily_guard_mode();
  v_hour      timestamptz := date_trunc('hour', now());
  v_ttl       integer := public.daily_guard_int('daily_guard_claim_ttl_s', 45, 20);
  v_fail_max  integer := public.daily_guard_int('daily_guard_user_fail_max', 3, 1);
  v_cooldown  integer := public.daily_guard_int('daily_guard_user_fail_cooldown_s', 120, 0);
  v_per_day   integer := public.daily_guard_int('daily_guard_user_evals_per_day', 48, 1);
  v_per_orig  integer := public.daily_guard_int('daily_guard_origin_evals_per_hour', 60, 1);
  v_brk_max   integer := public.daily_guard_int('daily_guard_breaker_fail_threshold', 10, 1);
  v_brk_win   integer := public.daily_guard_int('daily_guard_breaker_window_s', 300, 60);
  v_attempt   public.daily_attempts;
  v_has_att   boolean;
  v_row       public.daily_eval_claims;
  v_has_row   boolean;
  v_block     text := NULL;
  v_claim     uuid := gen_random_uuid();
  v_got       uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'daily_claim: usuário ausente' USING ERRCODE = '22023';
  END IF;
  IF v_mode = 'desligado' THEN
    RETURN jsonb_build_object('status', 'bypass', 'mode', v_mode, 'hour', v_hour);
  END IF;

  -- M1: serializa TUDO o que é do mesmo usuário/hora (reserva e gravação), inclusive
  -- quando a linha ainda não existe (o FOR UPDATE sozinho não trava linha ausente)
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || '|' || v_hour::text, 0));

  SELECT * INTO v_row FROM public.daily_eval_claims
   WHERE user_id = p_user_id AND challenge_hour = v_hour FOR UPDATE;
  v_has_row := FOUND;  -- M2: FOUND, não "linha IS NOT NULL" (falso se algum campo for NULL)

  -- (a) já jogou nesta hora: nenhuma IA
  SELECT * INTO v_attempt FROM public.daily_attempts
   WHERE user_id = p_user_id AND challenge_hour = v_hour;
  v_has_att := FOUND;
  IF v_has_att THEN
    v_block := 'already_played';
  -- (b) avaliação em andamento (duplo toque, outra aba, outro processo)
  ELSIF v_has_row AND v_row.state = 'running' AND v_row.expires_at > now() THEN
    v_block := 'in_progress';
  -- (c) disjuntor global: o provedor está falhando para todos
  ELSIF public.ai_quota_used('daily_provider_fail', v_brk_win) >= v_brk_max THEN
    v_block := 'provider_unavailable';
  -- (d) pausa do usuário após falhas SEGUIDAS do provedor (tentativa nunca é gasta)
  ELSIF v_has_row AND v_row.state = 'failed' AND v_row.failures >= v_fail_max
        AND v_row.last_failure_at > now() - make_interval(secs => v_cooldown) THEN
    v_block := 'cooldown';
  -- (e) limites de abuso: avaliações por usuário/dia e por origem/hora
  ELSIF public.ai_quota_used('daily_user:' || p_user_id::text, 86400) >= v_per_day THEN
    v_block := 'rate_limited';
  ELSIF p_origin IS NOT NULL
        AND public.ai_quota_used('daily_origin:' || left(p_origin, 64), 3600) >= v_per_orig THEN
    v_block := 'rate_limited';
  END IF;

  IF v_block IS NOT NULL AND v_mode = 'aplicar' THEN
    PERFORM public.daily_guard_log(jsonb_build_object('step', 'claim', 'mode', v_mode,
      'decision', v_block, 'blocked', true, 'hour', v_hour));
    IF v_block = 'already_played' THEN
      RETURN jsonb_build_object('status', 'already_played', 'mode', v_mode, 'hour', v_hour,
                                'already_played', true, 'attempt', to_jsonb(v_attempt));
    END IF;
    RETURN jsonb_build_object('status', v_block, 'mode', v_mode, 'hour', v_hour);
  END IF;

  -- reserva atômica: cria, ou renova reserva FALHA ou VENCIDA. Nunca renova 'running'
  -- válida nem 'done' (M1: uma 'done' renovada abriria uma 2ª IA).
  INSERT INTO public.daily_eval_claims AS c (user_id, challenge_hour, claim_id, state, expires_at)
  VALUES (p_user_id, v_hour, v_claim, 'running', now() + make_interval(secs => v_ttl))
  ON CONFLICT (user_id, challenge_hour) DO UPDATE
     SET claim_id = v_claim, state = 'running', started_at = now(),
         expires_at = now() + make_interval(secs => v_ttl), updated_at = now()
   WHERE c.state = 'failed' OR (c.state = 'running' AND c.expires_at <= now())
  RETURNING claim_id INTO v_got;

  IF v_got IS DISTINCT FROM v_claim THEN
    -- outro pedido SIMULTÂNEO criou a reserva primeiro (ON CONFLICT esperou o commit dele)
    IF v_mode = 'aplicar' THEN
      PERFORM public.daily_guard_log(jsonb_build_object('step', 'claim', 'mode', v_mode,
        'decision', 'in_progress', 'blocked', true, 'hour', v_hour));
      RETURN jsonb_build_object('status', 'in_progress', 'mode', v_mode, 'hour', v_hour);
    END IF;
    PERFORM public.daily_guard_log(jsonb_build_object('step', 'claim', 'mode', v_mode,
      'decision', coalesce(v_block, 'in_progress'), 'blocked', false, 'hour', v_hour));
    RETURN jsonb_build_object('status', 'pass_no_claim', 'mode', v_mode, 'hour', v_hour, 'would_block', coalesce(v_block, 'in_progress'));
  END IF;

  -- conta a avaliação (usuário/dia e origem/hora) só quando a IA vai ser chamada
  PERFORM public.ai_quota_add('daily_user:' || p_user_id::text, 86400);
  IF p_origin IS NOT NULL THEN
    PERFORM public.ai_quota_add('daily_origin:' || left(p_origin, 64), 3600);
  END IF;
  PERFORM public.daily_guard_log(jsonb_build_object('step', 'claim', 'mode', v_mode,
    'decision', coalesce(v_block, 'claimed'), 'blocked', false, 'hour', v_hour));
  RETURN jsonb_build_object('status', 'claimed', 'claim_id', v_claim, 'mode', v_mode, 'hour', v_hour, 'would_block', v_block);
END $$;

-- 6) Finalização com sucesso: só o claim vigente registra --------------------------
-- {status:'recorded', result}   result = retorno INALTERADO de submit_daily_attempt_scored
-- {status:'stale'}              (aplicar) outra reserva tomou o lugar: nada é gravado
-- {status:'hour_changed'}       (aplicar) a hora virou durante a avaliação: nada é gravado, tentativa não gasta
CREATE OR REPLACE FUNCTION public.daily_finish_ok(
  p_user_id uuid, p_hour timestamptz, p_claim_id uuid,
  p_guess text, p_time_seconds integer, p_similarity integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_mode  text := public.daily_guard_mode();
  v_row   public.daily_eval_claims;
  v_issue text := NULL;
  v_res   jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || '|' || p_hour::text, 0));  -- M1
  SELECT * INTO v_row FROM public.daily_eval_claims
   WHERE user_id = p_user_id AND challenge_hour = p_hour FOR UPDATE;

  IF NOT FOUND OR v_row.claim_id IS DISTINCT FROM p_claim_id OR v_row.state <> 'running' THEN
    v_issue := 'stale';
  ELSIF date_trunc('hour', now()) <> p_hour THEN
    v_issue := 'hour_changed';
  END IF;

  IF v_issue IS NOT NULL AND v_mode = 'aplicar' THEN
    IF v_issue = 'hour_changed' THEN
      UPDATE public.daily_eval_claims
         SET state = 'failed', last_failure_kind = 'hour_changed', updated_at = now()
       WHERE user_id = p_user_id AND challenge_hour = p_hour AND claim_id = p_claim_id;
    END IF;
    PERFORM public.daily_guard_log(jsonb_build_object('step', 'finish', 'mode', v_mode,
      'decision', v_issue, 'blocked', true, 'hour', p_hour));
    RETURN jsonb_build_object('status', v_issue, 'mode', v_mode);
  END IF;

  -- pontuação, streak e conquistas: função ATUAL, sem mudança (mesma transação)
  v_res := public.submit_daily_attempt_scored(p_user_id, p_guess, p_time_seconds, p_similarity);

  UPDATE public.daily_eval_claims
     SET state = 'done', updated_at = now()
   WHERE user_id = p_user_id AND challenge_hour = p_hour AND claim_id = p_claim_id;

  PERFORM public.daily_guard_log(jsonb_build_object('step', 'finish', 'mode', v_mode,
    'decision', coalesce(v_issue, 'recorded'), 'blocked', false, 'hour', p_hour,
    'already_played', coalesce((v_res ->> 'already_played')::boolean, false)));
  RETURN jsonb_build_object('status', 'recorded', 'mode', v_mode, 'would_block', v_issue, 'result', v_res);
END $$;

-- 7) Finalização com falha: a tentativa NÃO é gasta --------------------------------
-- p_kind: 'provider' (5xx, 429, timeout, rede: conta no jogador e — só a 1ª dele
--                     na hora — no disjuntor global; A3: um jogador não abre o disjuntor sozinho)
--         'invalid'  (resposta fora do formato: conta no jogador, NUNCA no disjuntor —
--                     um palpite malicioso pode induzi-la)
--         'persist'  (falha nossa ao gravar: não pune o jogador)
CREATE OR REPLACE FUNCTION public.daily_finish_fail(
  p_user_id uuid, p_hour timestamptz, p_claim_id uuid, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_mode    text := public.daily_guard_mode();
  v_brk_win integer := public.daily_guard_int('daily_guard_breaker_window_s', 300, 60);
  v_kind    text := CASE WHEN p_kind IN ('provider', 'invalid', 'persist') THEN p_kind ELSE 'provider' END;
  v_n       integer;
  v_fails   integer;
BEGIN
  UPDATE public.daily_eval_claims
     SET state = 'failed',
         failures = failures + CASE WHEN v_kind IN ('provider', 'invalid') THEN 1 ELSE 0 END,
         last_failure_at = now(), last_failure_kind = v_kind, updated_at = now()
   WHERE user_id = p_user_id AND challenge_hour = p_hour
     AND claim_id = p_claim_id AND state = 'running'
  RETURNING failures INTO v_fails;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- disjuntor global: só falha TRANSITÓRIA e só a 1ª do jogador nesta hora
  IF v_kind = 'provider' AND v_n = 1 AND v_fails = 1 THEN
    PERFORM public.ai_quota_add('daily_provider_fail', v_brk_win);
  END IF;
  PERFORM public.daily_guard_log(jsonb_build_object('step', 'fail', 'mode', v_mode,
    'decision', v_kind, 'matched', v_n = 1, 'hour', p_hour));
  RETURN jsonb_build_object('status', CASE WHEN v_n = 1 THEN 'released' ELSE 'stale' END, 'mode', v_mode);
END $$;

-- 8) Limpeza (dados operacionais, sem dados de jogo) --------------------------------
CREATE OR REPLACE FUNCTION public.daily_guard_cleanup()
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  DELETE FROM public.daily_eval_claims WHERE updated_at < now() - interval '3 days';
  DELETE FROM public.ai_quota WHERE window_start < now() - interval '3 days';
$$;

-- 9) Permissões: só service_role ---------------------------------------------------
REVOKE ALL ON FUNCTION public.daily_guard_int(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_guard_mode() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_quota_used(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_quota_add(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_guard_log(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_claim(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_finish_ok(uuid, timestamptz, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_finish_fail(uuid, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_guard_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daily_claim(uuid, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_finish_ok(uuid, timestamptz, uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_finish_fail(uuid, timestamptz, uuid, text) TO service_role;

-- 10) Cron de limpeza (só se o pg_cron existir) --------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-daily-guard-cleanup') THEN
      PERFORM cron.unschedule('verbete-daily-guard-cleanup');
    END IF;
    PERFORM cron.schedule('verbete-daily-guard-cleanup', '17 * * * *', 'SELECT public.daily_guard_cleanup();');
  END IF;
END $$;
