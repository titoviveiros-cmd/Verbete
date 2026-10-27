-- ROLLBACK de 20261027200000_data_retention.sql: para a limpeza automática
-- (salas, convidados, denúncias). O que já foi apagado NÃO volta.
--   npx supabase db query --linked -f supabase/rollback/data_retention.sql
-- Depois: voltar os textos de /privacy, /delete-account e docs para "sem prazo".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-data-retention') THEN
    PERFORM cron.unschedule('verbete-data-retention');
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.run_data_retention(int, int, int);
DROP FUNCTION IF EXISTS public.retention_purge_reports(int);
DROP FUNCTION IF EXISTS public.retention_purge_anon_users(int);
DROP FUNCTION IF EXISTS public.retention_anon_candidates(timestamptz, uuid, int);
DROP FUNCTION IF EXISTS public.retention_purge_rooms(int);
DELETE FROM public.ops_heartbeat WHERE job = 'data_retention';

DROP TRIGGER IF EXISTS rooms_track_finished_at ON public.rooms;
DROP FUNCTION IF EXISTS public.rooms_track_finished_at();
DROP INDEX IF EXISTS public.reports_resolved_at_idx;
DROP INDEX IF EXISTS public.idx_votes_definition_id;
DROP INDEX IF EXISTS public.rooms_finished_at_idx;
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_finished_at_check;
ALTER TABLE public.rooms DROP COLUMN IF EXISTS finished_at;
