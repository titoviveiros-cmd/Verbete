-- =============================================================================
-- Contenção da IA — interruptor app_config.ai_mode (05/11/2026)
-- Doc: docs/contencao-ia.md · Parecer: PARECER-IA-13PLUS.md §5 (nível 1).
--
--   'ligado'   → comportamento de sempre (PADRÃO desta migration)
--   'suspenso' → nenhuma chamada ao provedor de IA (Gemini): juiz do 🧠 marca a
--                rodada julgada sem bônus; bots e 💡/🤖 nas reservas; Desafio
--                Diário em pausa (sem gastar tentativa).
-- Valor ausente ou inválido = 'ligado' (lido pelas edges e pelo Worker).
--
-- SÓ CONFIGURAÇÃO: nenhuma função, tabela ou política muda. Aplicar NÃO muda
-- comportamento (o valor inserido é 'ligado' e ON CONFLICT preserva um valor
-- já gravado à mão).
-- O GRANT abaixo só torna EXPLÍCITO o que os privilégios padrão do Supabase já
-- dão à service_role (as edges e o Worker leem a chave com ela); anon e
-- authenticated continuam sem acesso (RLS ligada e sem policies).
--
-- ATIVAR (exige autorização):  UPDATE public.app_config SET value = 'suspenso', updated_at = now() WHERE key = 'ai_mode';
-- ROLLBACK do modo:             UPDATE public.app_config SET value = 'ligado',   updated_at = now() WHERE key = 'ai_mode';
-- ROLLBACK da migration:        DELETE FROM public.app_config WHERE key = 'ai_mode';  (equivale a 'ligado')
-- =============================================================================

INSERT INTO public.app_config (key, value) VALUES ('ai_mode', 'ligado')
ON CONFLICT (key) DO NOTHING;

GRANT SELECT ON TABLE public.app_config TO service_role;
