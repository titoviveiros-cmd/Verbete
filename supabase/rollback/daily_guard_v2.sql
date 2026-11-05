-- ROLLBACK da migration 20261105150000_daily_guard_v2.sql (V2 — Desafio Diário).
--
-- ORDEM OBRIGATÓRIA (Red Team A1):
--   1. Voltar o Worker para a versão ANTERIOR à V2 (npx wrangler rollback <versão> --name jogo)
--      e confirmar que ela está servindo 100% do tráfego.
--   2. Só então rodar este script.
-- ATENÇÃO: o Worker NOVO chama daily_claim mesmo no modo 'desligado' (é a função que
-- devolve 'bypass'). Rodar este script com o Worker novo no ar derruba o Diário
-- (fail-closed: "indisponível"). O modo 'desligado' é a ALTERNATIVA a este script
-- (desliga a V2 sem apagar nada), não um passo antes dele.
--
-- Dados de jogo NÃO são tocados: daily_attempts, user_stats, user_achievements e
-- submit_daily_attempt_scored ficam exatamente como estão. Só saem as reservas
-- (dados operacionais, apagáveis) e os contadores.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-daily-guard-cleanup') THEN
      PERFORM cron.unschedule('verbete-daily-guard-cleanup');
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.daily_guard_cleanup();
DROP FUNCTION IF EXISTS public.daily_finish_fail(uuid, timestamptz, uuid, text);
DROP FUNCTION IF EXISTS public.daily_finish_ok(uuid, timestamptz, uuid, text, integer, integer);
DROP FUNCTION IF EXISTS public.daily_claim(uuid, timestamptz, text);
DROP FUNCTION IF EXISTS public.daily_guard_log(jsonb);
DROP FUNCTION IF EXISTS public.ai_quota_add(text, integer);
DROP FUNCTION IF EXISTS public.ai_quota_used(text, integer);
DROP FUNCTION IF EXISTS public.ai_quota_window(integer);  -- existia só no rascunho
DROP FUNCTION IF EXISTS public.daily_guard_mode();
DROP FUNCTION IF EXISTS public.daily_guard_int(text, integer, integer);
DROP FUNCTION IF EXISTS public.daily_guard_int(text, integer);

DROP TABLE IF EXISTS public.ai_quota;
DROP TABLE IF EXISTS public.daily_eval_claims;

DELETE FROM public.app_config WHERE key IN (
  'daily_guard_mode', 'daily_guard_claim_ttl_s', 'daily_guard_user_fail_max',
  'daily_guard_user_fail_cooldown_s', 'daily_guard_user_evals_per_day',
  'daily_guard_origin_evals_per_hour', 'daily_guard_breaker_fail_threshold',
  'daily_guard_breaker_window_s'
);
-- Os eventos 'daily_guard' em ops_events seguem a retenção normal de ops_events.
