-- 1) Fix daily challenge RPC: omit word_id from response, and revoke anon execute is not needed
--    since anonymous play is supported. Just stop serializing the whole row.
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
    'challenge', jsonb_build_object(
      'id', v_challenge.id,
      'challenge_date', v_challenge.challenge_date,
      'challenge_hour', v_challenge.challenge_hour
    ),
    'word', jsonb_build_object('id', v_word.id, 'word', v_word.word, 'category', v_word.category)
  );
END;
$function$;

-- 2) Restrict user_stats SELECT to owner only.
DROP POLICY IF EXISTS "user_stats authenticated read" ON public.user_stats;
CREATE POLICY "user_stats self read"
  ON public.user_stats
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);


