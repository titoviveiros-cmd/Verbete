-- 1) Lock down players score-related columns from client writes
REVOKE UPDATE (score, coordinator_count, writing_extensions)
  ON public.players FROM anon, authenticated;

-- 2) Lock down definitions truth flags from client writes
REVOKE UPDATE (is_truth, near_truth)
  ON public.definitions FROM anon, authenticated;

-- 3) Remove definitions from realtime publication to avoid leaking is_truth/near_truth.
-- Game state already syncs via rooms/votes; clients fetch definitions via get_room_state / get_round_reveal.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'definitions'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.definitions';
  END IF;
END $$;

