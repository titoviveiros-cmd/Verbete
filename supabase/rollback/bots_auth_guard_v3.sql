-- ROLLBACK da migration 20261105180000_bots_auth_guard_v3.sql (V3 mínima — edges de IA).
--
-- Desligar a V3 NÃO exige este script: basta
--   UPDATE public.app_config SET value = 'desligado', updated_at = now() WHERE key = 'bots_auth_mode';
-- (as edges novas voltam ao fluxo antigo no pedido seguinte, sem deploy).
--
-- ORDEM para remover de vez:
--   1. Voltar bot-definitions, bot-definitions-v2 e score-similarity para a versão
--      ANTERIOR à V3 (deploy do commit anterior) — ou deixar o modo em 'desligado'.
--   2. Só então rodar este script. Com as edges novas no ar e as funções apagadas,
--      'aplicar' viraria guard_error (503); 'observar' só registraria.
--
-- Dados de jogo e a tabela ai_quota (V2) não são tocados (os contadores
-- 'bots_round:*' saem sozinhos na limpeza da V2, em 3 dias).

DROP FUNCTION IF EXISTS public.bots_quota_take(uuid, integer);
DELETE FROM public.app_config WHERE key IN ('bots_auth_mode', 'bots_ai_round_limit');
