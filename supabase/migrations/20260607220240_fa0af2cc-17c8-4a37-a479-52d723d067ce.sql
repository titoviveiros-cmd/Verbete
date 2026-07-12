
CREATE OR REPLACE FUNCTION public.get_ranking_top(p_limit integer DEFAULT 50)
RETURNS TABLE (
  user_id uuid,
  total_score integer,
  games_played integer,
  games_won integer,
  best_match_score integer,
  display_name text,
  avatar text,
  color text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.user_id,
    s.total_score,
    s.games_played,
    s.games_won,
    s.best_match_score,
    COALESCE(p.display_name, 'Jogador') AS display_name,
    COALESCE(p.avatar, '🦊') AS avatar,
    COALESCE(p.color, '#FFD166') AS color
  FROM public.user_stats s
  LEFT JOIN public.profiles p ON p.user_id = s.user_id
  WHERE s.total_score > 0
  ORDER BY s.total_score DESC, s.games_won DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 200);
$$;

GRANT EXECUTE ON FUNCTION public.get_ranking_top(integer) TO anon, authenticated;


