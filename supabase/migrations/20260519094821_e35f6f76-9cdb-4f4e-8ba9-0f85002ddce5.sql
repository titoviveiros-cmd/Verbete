-- Fix daily_attempts SELECT to be self-only
DROP POLICY IF EXISTS "daily_attempts self read" ON public.daily_attempts;
CREATE POLICY "daily_attempts self read"
ON public.daily_attempts
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Add auth check to record_match_result and lock down EXECUTE
CREATE OR REPLACE FUNCTION public.record_match_result(p_user_id uuid, p_room_code text, p_final_score integer, p_position integer, p_players_count integer, p_rounds_coordinated integer DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO public.user_stats (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

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
$function$;

REVOKE EXECUTE ON FUNCTION public.record_match_result(uuid, text, integer, integer, integer, integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_match_result(uuid, text, integer, integer, integer, integer) TO authenticated;

-- Revoke public access to internal tick/advance helpers
REVOKE EXECUTE ON FUNCTION public.extend_writing_or_advance(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reset_room(uuid) FROM anon, authenticated, PUBLIC;

