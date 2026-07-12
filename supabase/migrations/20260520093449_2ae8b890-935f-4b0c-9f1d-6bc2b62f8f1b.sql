
-- Enable trigram extension for similarity scoring
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Add similarity column (0-100) to record how close the guess was
ALTER TABLE public.daily_attempts
  ADD COLUMN IF NOT EXISTS similarity integer NOT NULL DEFAULT 0;

-- Update submit_daily_attempt to use 80% similarity threshold and store similarity
CREATE OR REPLACE FUNCTION public.submit_daily_attempt(p_user_id uuid, p_guess text, p_time_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_hour timestamptz := date_trunc('hour', now());
  v_prev_hour timestamptz := v_hour - INTERVAL '1 hour';
  v_challenge public.daily_challenges;
  v_word public.words;
  v_truth text;
  v_guess_norm text;
  v_sim_raw real;
  v_similarity integer := 0;
  v_is_correct boolean := false;
  v_score integer := 0;
  v_existing public.daily_attempts;
  v_stats public.user_stats;
  v_new_streak integer := 1;
  v_unlocked_codes text[] := ARRAY[]::text[];
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_existing FROM public.daily_attempts
  WHERE user_id = p_user_id AND challenge_hour = v_hour;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('already_played', true, 'attempt', to_jsonb(v_existing));
  END IF;

  PERFORM public.get_or_create_daily_challenge();
  SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_hour = v_hour;
  SELECT * INTO v_word FROM public.words WHERE id = v_challenge.word_id;

  v_truth := lower(extensions.unaccent(coalesce(v_word.meaning, '')));
  v_guess_norm := lower(extensions.unaccent(coalesce(p_guess, '')));

  -- Trigram similarity (0..1) → percent (0..100)
  v_sim_raw := extensions.similarity(v_guess_norm, v_truth);
  v_similarity := GREATEST(0, LEAST(100, (v_sim_raw * 100)::int));

  v_is_correct := v_similarity >= 80;

  IF v_is_correct THEN
    v_score := GREATEST(100 - COALESCE(p_time_seconds, 60), 20);
  END IF;

  INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, is_correct, score, time_seconds, similarity)
  VALUES (p_user_id, v_hour::date, v_hour, COALESCE(p_guess, ''), v_is_correct, v_score, COALESCE(p_time_seconds, 0), v_similarity);

  INSERT INTO public.user_stats (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_stats FROM public.user_stats WHERE user_id = p_user_id;

  IF v_stats.last_played_hour = v_prev_hour THEN
    v_new_streak := v_stats.current_streak + 1;
  ELSIF v_stats.last_played_hour = v_hour THEN
    v_new_streak := v_stats.current_streak;
  ELSE
    v_new_streak := 1;
  END IF;

  UPDATE public.user_stats SET
    current_streak = v_new_streak,
    best_streak = GREATEST(best_streak, v_new_streak),
    last_played_date = v_hour::date,
    last_played_hour = v_hour,
    updated_at = now()
  WHERE user_id = p_user_id;

  IF NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'first_daily') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'first_daily');
    v_unlocked_codes := array_append(v_unlocked_codes, 'first_daily');
  END IF;
  IF v_new_streak >= 3 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_3') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_3');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_3');
  END IF;
  IF v_new_streak >= 7 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_7') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_7');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_7');
  END IF;
  IF v_new_streak >= 30 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_30') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_30');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_30');
  END IF;

  RETURN jsonb_build_object(
    'already_played', false,
    'is_correct', v_is_correct,
    'score', v_score,
    'similarity', v_similarity,
    'truth', v_word.meaning,
    'word', v_word.word,
    'current_streak', v_new_streak,
    'unlocked', v_unlocked_codes
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.submit_daily_attempt(uuid, text, integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_daily_attempt(uuid, text, integer) TO authenticated;

-- RPC to fetch the current user's attempt for this hour together with the truth,
-- so the player can review what they wrote vs the correct meaning.
CREATE OR REPLACE FUNCTION public.get_my_daily_review()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_hour timestamptz := date_trunc('hour', now());
  v_attempt public.daily_attempts;
  v_challenge public.daily_challenges;
  v_word public.words;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_attempt FROM public.daily_attempts
  WHERE user_id = auth.uid() AND challenge_hour = v_hour;

  IF v_attempt IS NULL THEN
    RETURN jsonb_build_object('played', false);
  END IF;

  SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_hour = v_hour;
  SELECT * INTO v_word FROM public.words WHERE id = v_challenge.word_id;

  RETURN jsonb_build_object(
    'played', true,
    'attempt', jsonb_build_object(
      'guess', v_attempt.guess,
      'is_correct', v_attempt.is_correct,
      'score', v_attempt.score,
      'time_seconds', v_attempt.time_seconds,
      'similarity', v_attempt.similarity,
      'challenge_hour', v_attempt.challenge_hour
    ),
    'truth', v_word.meaning,
    'word', v_word.word
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_my_daily_review() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_daily_review() TO authenticated;


