-- ROLLBACK de 20261111130000_denuncia_retorno_recurso.sql: a tabela de
-- recursos e as colunas novas saem (os RECURSOS registrados e as decisões
-- action/decision_reason/review_kind são PERDIDOS — exportar antes, se houver).
-- Denúncias e bans continuam; o painel volta a só descartar/banir.
--   npx supabase db query --linked -f supabase/rollback/denuncia_retorno_recurso.sql
DROP TABLE IF EXISTS public.moderation_appeals;
DROP INDEX IF EXISTS public.banned_report_idx;
ALTER TABLE public.banned_players DROP COLUMN IF EXISTS report_id;
DROP INDEX IF EXISTS public.reports_offender_user_action_idx;
DROP INDEX IF EXISTS public.reports_reporter_idx;
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_review_kind_chk;
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_decision_reason_chk;
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_action_chk;
ALTER TABLE public.reports
  DROP COLUMN IF EXISTS review_kind,
  DROP COLUMN IF EXISTS decision_reason,
  DROP COLUMN IF EXISTS action;
