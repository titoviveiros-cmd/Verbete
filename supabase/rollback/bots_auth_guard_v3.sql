-- ROLLBACK da migration 20261105180000_bots_auth_guard_v3.sql (V3 mínima — edges de IA).
--
-- Desligar a V3 NÃO exige este script: basta
--   UPDATE public.app_config SET value = 'desligado', updated_at = now() WHERE key = 'bots_auth_mode';
-- (as edges novas voltam ao fluxo antigo no pedido seguinte, sem deploy).
--
-- ORDEM para remover de vez:
--   1. Voltar bot-definitions, bot-definitions-v2 e score-similarity para a versão
--      ANTERIOR à V3 (deploy do commit anterior) — ou deixar o modo em 'desligado'.
--   2. Só então rodar este script. Com as edges novas no ar e as chaves apagadas,
--      o modo vira 'observar' (padrão seguro): nada bloqueia, só registra.
--
-- O GRANT de ai_quota_add ao service_role NÃO é revogado: ele já vinha dos
-- privilégios padrão do Supabase e a V2 (Diário) pode depender dele.
-- Dados de jogo e a tabela ai_quota (V2) não são tocados.

DELETE FROM public.app_config WHERE key IN ('bots_auth_mode', 'bots_ai_round_limit');
