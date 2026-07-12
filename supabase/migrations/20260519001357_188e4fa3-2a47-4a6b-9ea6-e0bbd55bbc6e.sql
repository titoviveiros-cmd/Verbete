
CREATE OR REPLACE FUNCTION public.reset_user_stats(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  DELETE FROM public.daily_attempts    WHERE user_id = p_user_id;
  DELETE FROM public.match_history     WHERE user_id = p_user_id;
  DELETE FROM public.user_achievements WHERE user_id = p_user_id;

  INSERT INTO public.user_stats (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.user_stats SET
    games_played = 0,
    games_won = 0,
    total_score = 0,
    best_match_score = 0,
    rounds_coordinated = 0,
    current_streak = 0,
    best_streak = 0,
    last_played_date = NULL,
    last_played_hour = NULL,
    updated_at = now()
  WHERE user_id = p_user_id;
END;
$function$;


