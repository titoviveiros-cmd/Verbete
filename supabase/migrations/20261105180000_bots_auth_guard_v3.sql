-- =============================================================================
-- V3 mínima — guarda das Edge Functions de IA (05/11/2026)
-- Projeto: verbete-piloto-ia/PROJETO-SEGURANCA-IA-V1-V2-V3.md (frente V3).
-- Documento: docs/seguranca-v3-edges.md
--
-- Esta migration SÓ adiciona configuração (nada de tabela, função ou dado de jogo):
--   * bots_auth_mode      — interruptor das edges bot-definitions, bot-definitions-v2
--                           e score-similarity:
--       'desligado' → fluxo antigo (rollback sem deploy);
--       'observar'  → (PADRÃO) decide e REGISTRA em ops_events (kind 'ai_guard')
--                     o que bloquearia, sem bloquear;
--       'aplicar'   → bloqueia (401 sem sessão, 403 fora da sala, 429 cota,
--                     score-similarity sem IA para rodada já julgada).
--     Valor ausente ou inválido é lido como 'observar' pelas edges — nunca 'aplicar'.
--   * bots_ai_round_limit — pedidos de IA dos bots por sala/rodada (contador em
--                           public.ai_quota, da V2). As edges limitam a [20, 1000].
-- ON CONFLICT DO NOTHING: reaplicar nunca sobrescreve um valor já ajustado.
--
-- DEPENDE da V2 (20261105150000_daily_guard_v2.sql): public.ai_quota e
-- public.ai_quota_add(text, integer). O GRANT abaixo só torna EXPLÍCITO o acesso da
-- chave de serviço (as edges) ao contador — a V2 revogou de PUBLIC/anon/authenticated
-- e o acesso do service_role vinha só dos privilégios padrão do Supabase.
-- Nada é concedido a anon/authenticated.
-- ROLLBACK: supabase/rollback/bots_auth_guard_v3.sql (depois de voltar as edges).
-- =============================================================================

INSERT INTO public.app_config (key, value) VALUES
  ('bots_auth_mode', 'observar'),
  ('bots_ai_round_limit', '60')   -- 12 jogadores × (💡 + sugestão automática + recargas) + bots
ON CONFLICT (key) DO NOTHING;

GRANT EXECUTE ON FUNCTION public.ai_quota_add(text, integer) TO service_role;
