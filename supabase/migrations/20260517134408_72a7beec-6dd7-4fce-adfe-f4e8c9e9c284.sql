-- ============================================================
-- Sprint 1: Daily Challenge + Streaks + Achievements
-- ============================================================

-- 1. Daily Challenges (uma palavra por dia, igual para todos)
CREATE TABLE public.daily_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_date date NOT NULL UNIQUE,
  word_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.daily_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_challenges public read"
  ON public.daily_challenges FOR SELECT
  USING (true);

-- 2. Daily Attempts (tentativa por jogador por dia)
CREATE TABLE public.daily_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  challenge_date date NOT NULL,
  guess text NOT NULL,
  is_correct boolean NOT NULL DEFAULT false,
  score integer NOT NULL DEFAULT 0,
  time_seconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, challenge_date)
);

CREATE INDEX idx_daily_attempts_date_score ON public.daily_attempts (challenge_date, score DESC);
CREATE INDEX idx_daily_attempts_user ON public.daily_attempts (user_id, challenge_date DESC);

ALTER TABLE public.daily_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_attempts public read"
  ON public.daily_attempts FOR SELECT
  USING (true);

CREATE POLICY "daily_attempts self insert"
  ON public.daily_attempts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 3. Achievements catalog
CREATE TABLE public.achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL,
  emoji text NOT NULL DEFAULT '🏆',
  rarity text NOT NULL DEFAULT 'common' CHECK (rarity IN ('common','rare','epic','legendary')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.achievements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "achievements public read"
  ON public.achievements FOR SELECT
  USING (true);

-- 4. User Achievements (unlocked)
CREATE TABLE public.user_achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  achievement_code text NOT NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, achievement_code)
);

CREATE INDEX idx_user_achievements_user ON public.user_achievements (user_id, unlocked_at DESC);

ALTER TABLE public.user_achievements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_achievements public read"
  ON public.user_achievements FOR SELECT
  USING (true);

-- 5. Streak columns on user_stats
ALTER TABLE public.user_stats
  ADD COLUMN IF NOT EXISTS current_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS best_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_played_date date;

-- 6. Seed 10 conquistas iniciais
INSERT INTO public.achievements (code, name, description, emoji, rarity) VALUES
  ('first_win',        'Primeira Vitória',     'Vença sua primeira partida.',                    '🥇', 'common'),
  ('first_daily',      'Estreante Diário',     'Complete seu primeiro desafio diário.',          '📅', 'common'),
  ('streak_3',         'Em Chamas',            'Jogue 3 dias seguidos.',                         '🔥', 'common'),
  ('streak_7',         'Semana Perfeita',      'Jogue 7 dias seguidos.',                         '⚡', 'rare'),
  ('streak_30',        'Lenda do Verbete',     'Jogue 30 dias seguidos.',                        '👑', 'legendary'),
  ('bluff_master',     'Mestre do Blefe',      'Receba 5+ votos em uma única definição falsa.',  '🎭', 'rare'),
  ('truth_seeker',     'Caçador da Verdade',   'Acerte a definição verdadeira 10 vezes.',        '🔍', 'common'),
  ('coordinator_5',    'Coordenador Nato',     'Coordene 5 rodadas.',                            '🎯', 'rare'),
  ('big_score',        'Pontuação Massiva',    'Faça 30+ pontos em uma única partida.',          '💯', 'epic'),
  ('social_butterfly', 'Borboleta Social',     'Jogue com 10 oponentes diferentes.',             '🦋', 'epic')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- Helper functions
-- ============================================================

-- Garante uma palavra do dia para a data informada (ou hoje)
CREATE OR REPLACE FUNCTION public.get_or_create_daily_challenge(p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challenge public.daily_challenges;
  v_word public.words;
BEGIN
  SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_date = p_date;

  IF v_challenge IS NULL THEN
    SELECT * INTO v_word FROM public.words
    WHERE rarity >= 3 AND char_length(meaning) <= 80
    ORDER BY random() LIMIT 1;

    IF v_word IS NULL THEN
      SELECT * INTO v_word FROM public.words ORDER BY random() LIMIT 1;
    END IF;

    INSERT INTO public.daily_challenges (challenge_date, word_id)
    VALUES (p_date, v_word.id)
    ON CONFLICT (challenge_date) DO NOTHING
    RETURNING * INTO v_challenge;

    IF v_challenge IS NULL THEN
      SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_date = p_date;
    END IF;
  END IF;

  SELECT * INTO v_word FROM public.words WHERE id = v_challenge.word_id;

  RETURN jsonb_build_object(
    'challenge', to_jsonb(v_challenge),
    'word', jsonb_build_object('id', v_word.id, 'word', v_word.word, 'category', v_word.category)
  );
END;
$$;

-- Registra a tentativa diária e atualiza streak + stats
CREATE OR REPLACE FUNCTION public.submit_daily_attempt(
  p_user_id uuid,
  p_guess text,
  p_time_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_today date := CURRENT_DATE;
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
  -- Já tentou hoje?
  SELECT * INTO v_existing FROM public.daily_attempts
  WHERE user_id = p_user_id AND challenge_date = v_today;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('already_played', true, 'attempt', to_jsonb(v_existing));
  END IF;

  -- Carrega palavra do dia
  PERFORM public.get_or_create_daily_challenge(v_today);
  SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_date = v_today;
  SELECT * INTO v_word FROM public.words WHERE id = v_challenge.word_id;

  -- Normaliza palpite vs significado verdadeiro
  v_truth := lower(extensions.unaccent(v_word.meaning));
  v_guess_norm := lower(extensions.unaccent(coalesce(p_guess, '')));
  v_is_correct := position(substring(v_guess_norm from 1 for 20) in v_truth) > 0
               OR position(substring(v_truth from 1 for 20) in v_guess_norm) > 0;

  IF v_is_correct THEN
    v_score := GREATEST(100 - COALESCE(p_time_seconds, 60), 20);
  END IF;

  INSERT INTO public.daily_attempts (user_id, challenge_date, guess, is_correct, score, time_seconds)
  VALUES (p_user_id, v_today, COALESCE(p_guess, ''), v_is_correct, v_score, COALESCE(p_time_seconds, 0));

  -- Garante stats
  INSERT INTO public.user_stats (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_stats FROM public.user_stats WHERE user_id = p_user_id;

  -- Streak: +1 se jogou ontem, mantém se jogou hoje, reseta caso contrário
  IF v_stats.last_played_date = v_today - 1 THEN
    v_new_streak := v_stats.current_streak + 1;
  ELSIF v_stats.last_played_date = v_today THEN
    v_new_streak := v_stats.current_streak;
  ELSE
    v_new_streak := 1;
  END IF;

  UPDATE public.user_stats SET
    current_streak = v_new_streak,
    best_streak = GREATEST(best_streak, v_new_streak),
    last_played_date = v_today,
    updated_at = now()
  WHERE user_id = p_user_id;

  -- Conquistas automáticas
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
$$;

