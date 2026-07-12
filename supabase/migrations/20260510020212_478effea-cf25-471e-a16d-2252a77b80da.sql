-- Rounds table: one row per (room, round) — guarantees idempotent scoring
CREATE TABLE IF NOT EXISTS public.rounds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  coordinator_id TEXT NOT NULL,
  word_id UUID,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, round)
);

ALTER TABLE public.rounds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rounds open select" ON public.rounds FOR SELECT USING (true);
CREATE POLICY "rounds open insert" ON public.rounds FOR INSERT WITH CHECK (true);

CREATE INDEX IF NOT EXISTS rounds_room_idx ON public.rounds(room_id);

-- Random words RPC
CREATE OR REPLACE FUNCTION public.get_random_words(
  exclude_ids UUID[] DEFAULT ARRAY[]::UUID[],
  min_rarity INT DEFAULT 2,
  lim INT DEFAULT 3
)
RETURNS SETOF public.words
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH preferred AS (
    SELECT * FROM public.words
    WHERE rarity >= min_rarity
      AND (exclude_ids IS NULL OR NOT (id = ANY(exclude_ids)))
    ORDER BY random()
    LIMIT lim
  ),
  fallback AS (
    SELECT * FROM public.words
    WHERE (exclude_ids IS NULL OR NOT (id = ANY(exclude_ids)))
    ORDER BY random()
    LIMIT lim
  )
  SELECT * FROM preferred
  UNION ALL
  SELECT * FROM fallback
  WHERE (SELECT count(*) FROM preferred) < lim
  LIMIT lim;
$$;

-- Reset room RPC: single transaction
CREATE OR REPLACE FUNCTION public.reset_room(p_room_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.players SET score = 0, coordinator_count = 0 WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  UPDATE public.rooms SET
    status = 'lobby',
    current_round = 0,
    current_coordinator = NULL,
    current_word_id = NULL,
    round_phase_ends_at = NULL,
    used_word_ids = ARRAY[]::UUID[]
  WHERE id = p_room_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_random_words(UUID[], INT, INT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_room(UUID) TO anon, authenticated;

