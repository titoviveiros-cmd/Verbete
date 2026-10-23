-- Denúncias (reports) SÓ pelo servidor (service role). Red Team da RC Android
-- 2.1.0, P0: o denunciante LIA as próprias denúncias (política "owner
-- select" + GRANT a anon/authenticated). Com autor e texto resolvidos no
-- servidor pelo id da cédula (src/lib/report-definition.ts), ler a tabela
-- durante a votação revelaria a definição verdadeira e o autor de cada
-- cédula. E o cliente ainda podia INSERIR denúncias forjadas direto pela API
-- (autor/conta quaisquer → banimento de inocente no painel). Todo acesso do
-- app a reports já é pelo servidor (moderation.functions.ts e
-- report-definition.ts, com supabaseAdmin).
-- ORDEM: aplicar ANTES do deploy do Worker com report-definition.ts.
-- Reversão: supabase/rollback/reports_server_only.sql
DROP POLICY IF EXISTS "reports authenticated insert" ON public.reports;
DROP POLICY IF EXISTS "reports owner or admin select" ON public.reports;
DROP POLICY IF EXISTS "reports admin update" ON public.reports;
REVOKE ALL ON public.reports FROM PUBLIC, anon, authenticated;
