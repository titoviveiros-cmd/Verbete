CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-tick-stalled-rooms') THEN
    PERFORM cron.unschedule('verbete-tick-stalled-rooms');
  END IF;
END$$;

SELECT cron.schedule(
  'verbete-tick-stalled-rooms',
  '* * * * *',
  $$SELECT public.tick_stalled_rooms();$$
);


