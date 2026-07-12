
-- ============ profiles ============
CREATE TABLE public.profiles (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT 'Jogador',
  avatar text NOT NULL DEFAULT '🦊',
  color text NOT NULL DEFAULT '#FFD166',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles public read" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "profiles self update" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "profiles self insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============ user_stats ============
CREATE TABLE public.user_stats (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  games_played int NOT NULL DEFAULT 0,
  games_won int NOT NULL DEFAULT 0,
  total_score int NOT NULL DEFAULT 0,
  best_match_score int NOT NULL DEFAULT 0,
  rounds_coordinated int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_stats public read" ON public.user_stats FOR SELECT USING (true);

-- ============ match_history ============
CREATE TABLE public.match_history (
  id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  room_code text NOT NULL,
  final_score int NOT NULL,
  position int NOT NULL,
  players_count int NOT NULL,
  played_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_match_history_user ON public.match_history(user_id, played_at DESC);

ALTER TABLE public.match_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "match_history self read" ON public.match_history FOR SELECT USING (auth.uid() = user_id);

-- ============ trigger: criar profile + stats no signup ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1), 'Jogador'))
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_stats (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ record_match_result RPC ============
CREATE OR REPLACE FUNCTION public.record_match_result(
  p_user_id uuid,
  p_room_code text,
  p_final_score int,
  p_position int,
  p_players_count int,
  p_rounds_coordinated int DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Garante stats existe
  INSERT INTO public.user_stats (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  -- Idempotência: não grava o mesmo resultado 2x (mesma sala+user)
  IF EXISTS (
    SELECT 1 FROM public.match_history
    WHERE user_id = p_user_id AND room_code = p_room_code
      AND played_at > now() - interval '6 hours'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.match_history (user_id, room_code, final_score, position, players_count)
  VALUES (p_user_id, p_room_code, p_final_score, p_position, p_players_count);

  UPDATE public.user_stats SET
    games_played = games_played + 1,
    games_won = games_won + (CASE WHEN p_position = 1 THEN 1 ELSE 0 END),
    total_score = total_score + p_final_score,
    best_match_score = GREATEST(best_match_score, p_final_score),
    rounds_coordinated = rounds_coordinated + p_rounds_coordinated,
    updated_at = now()
  WHERE user_id = p_user_id;
END;
$$;

-- ============ rooms.categories + RPC update ============
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS categories text[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.get_random_words(
  exclude_ids uuid[] DEFAULT ARRAY[]::uuid[],
  min_rarity integer DEFAULT 2,
  lim integer DEFAULT 3,
  p_categories text[] DEFAULT ARRAY[]::text[]
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
      AND (
        p_categories IS NULL
        OR array_length(p_categories, 1) IS NULL
        OR category = ANY(p_categories)
      )
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


