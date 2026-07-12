
-- Reset any partial column adds from prior failed migration
ALTER TABLE public.daily_challenges DROP COLUMN IF EXISTS challenge_hour;
ALTER TABLE public.daily_attempts   DROP COLUMN IF EXISTS challenge_hour;

-- Add column nullable first, backfill from challenge_date (midnight), then set NOT NULL
ALTER TABLE public.daily_challenges ADD COLUMN challenge_hour timestamptz;
UPDATE public.daily_challenges SET challenge_hour = (challenge_date::timestamp AT TIME ZONE 'UTC');
ALTER TABLE public.daily_challenges
  ALTER COLUMN challenge_hour SET NOT NULL,
  ALTER COLUMN challenge_hour SET DEFAULT date_trunc('hour', now());

ALTER TABLE public.daily_attempts ADD COLUMN challenge_hour timestamptz;
-- For attempts, bucket per (user, date) — preserve uniqueness by spacing per row if needed.
-- Easiest: set to midnight of challenge_date; (user,date) was unique → (user,hour) stays unique.
UPDATE public.daily_attempts SET challenge_hour = (challenge_date::timestamp AT TIME ZONE 'UTC');
ALTER TABLE public.daily_attempts
  ALTER COLUMN challenge_hour SET NOT NULL,
  ALTER COLUMN challenge_hour SET DEFAULT date_trunc('hour', now());

-- Swap unique constraints
ALTER TABLE public.daily_challenges DROP CONSTRAINT IF EXISTS daily_challenges_challenge_date_key;
ALTER TABLE public.daily_challenges
  ADD CONSTRAINT daily_challenges_challenge_hour_key UNIQUE (challenge_hour);

ALTER TABLE public.daily_attempts DROP CONSTRAINT IF EXISTS daily_attempts_user_id_challenge_date_key;
ALTER TABLE public.daily_attempts
  ADD CONSTRAINT daily_attempts_user_challenge_hour_key UNIQUE (user_id, challenge_hour);

CREATE INDEX IF NOT EXISTS idx_daily_attempts_hour_score
  ON public.daily_attempts (challenge_hour, score DESC);

ALTER TABLE public.daily_challenges ALTER COLUMN challenge_date DROP NOT NULL;
ALTER TABLE public.daily_attempts   ALTER COLUMN challenge_date DROP NOT NULL;

ALTER TABLE public.user_stats
  ADD COLUMN IF NOT EXISTS last_played_hour timestamptz;

-- RPCs
CREATE OR REPLACE FUNCTION public.get_or_create_daily_challenge(p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_hour timestamptz := date_trunc('hour', now());
  v_challenge public.daily_challenges;
  v_word public.words;
BEGIN
  SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_hour = v_hour;

  IF v_challenge IS NULL THEN
    SELECT * INTO v_word FROM public.words
    WHERE rarity >= 3 AND char_length(meaning) <= 80
    ORDER BY random() LIMIT 1;

    IF v_word IS NULL THEN
      SELECT * INTO v_word FROM public.words ORDER BY random() LIMIT 1;
    END IF;

    INSERT INTO public.daily_challenges (challenge_date, challenge_hour, word_id)
    VALUES (v_hour::date, v_hour, v_word.id)
    ON CONFLICT (challenge_hour) DO NOTHING
    RETURNING * INTO v_challenge;

    IF v_challenge IS NULL THEN
      SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_hour = v_hour;
    END IF;
  END IF;

  SELECT * INTO v_word FROM public.words WHERE id = v_challenge.word_id;

  RETURN jsonb_build_object(
    'challenge', to_jsonb(v_challenge),
    'word', jsonb_build_object('id', v_word.id, 'word', v_word.word, 'category', v_word.category)
  );
END;
$function$;

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
  v_is_correct boolean := false;
  v_score integer := 0;
  v_existing public.daily_attempts;
  v_stats public.user_stats;
  v_new_streak integer := 1;
  v_unlocked_codes text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_existing FROM public.daily_attempts
  WHERE user_id = p_user_id AND challenge_hour = v_hour;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('already_played', true, 'attempt', to_jsonb(v_existing));
  END IF;

  PERFORM public.get_or_create_daily_challenge();
  SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_hour = v_hour;
  SELECT * INTO v_word FROM public.words WHERE id = v_challenge.word_id;

  v_truth := lower(extensions.unaccent(v_word.meaning));
  v_guess_norm := lower(extensions.unaccent(coalesce(p_guess, '')));
  v_is_correct := position(substring(v_guess_norm from 1 for 20) in v_truth) > 0
               OR position(substring(v_truth from 1 for 20) in v_guess_norm) > 0;

  IF v_is_correct THEN
    v_score := GREATEST(100 - COALESCE(p_time_seconds, 60), 20);
  END IF;

  INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, is_correct, score, time_seconds)
  VALUES (p_user_id, v_hour::date, v_hour, COALESCE(p_guess, ''), v_is_correct, v_score, COALESCE(p_time_seconds, 0));

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
    'truth', v_word.meaning,
    'word', v_word.word,
    'current_streak', v_new_streak,
    'unlocked', v_unlocked_codes
  );
END;
$function$;


