ALTER PUBLICATION supabase_realtime ADD TABLE public.round_extensions;
ALTER TABLE public.round_extensions REPLICA IDENTITY FULL;

