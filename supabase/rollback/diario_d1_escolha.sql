-- ROLLBACK TOTAL da migration 20261108120000_diario_d1_escolha.sql (Diário D1, modo escolha).
--
-- O ROLLBACK NORMAL NÃO É ESTE: é `daily_mode = 'juiz'` em app_config (volta ao fluxo
-- atual na hora, sem migration de volta — critério 21). Este script é só para remover
-- o D1 do banco por completo.
--
-- ORDEM OBRIGATÓRIA:
--   1. daily_mode = 'juiz' (ninguém mais abre sessão do modo escolha).
--   2. Worker anterior ao D1 servindo 100% (o Worker D1 lê daily_mode; sem a função ele
--      cai em 'juiz', então também funciona — mas a revisão /admin/daily-choices quebra).
--   3. Só então rodar este script.
--
-- Dados de jogo: daily_attempts, user_stats e user_achievements NÃO são apagados nem
-- recalculados. As tentativas feitas no modo escolha CONTINUAM valendo (pontos, sequência,
-- conquistas); só se perde a marca `mode` delas (a coluna sai). Os conjuntos editoriais
-- (daily_choice_sets) SÃO apagados: exporte antes se quiser guardar a revisão.
-- submit_daily_attempt_scored e a V2 não são tocadas.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-daily-choice-cleanup') THEN
      PERFORM cron.unschedule('verbete-daily-choice-cleanup');
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.daily_choice_cleanup();
DROP FUNCTION IF EXISTS public.daily_choice_admin_review(uuid[], text, uuid);
DROP FUNCTION IF EXISTS public.daily_choice_admin_edit(uuid, text[], jsonb);
DROP FUNCTION IF EXISTS public.daily_choice_admin_add_drafts(jsonb);
DROP FUNCTION IF EXISTS public.daily_choice_admin_pool(integer);
DROP FUNCTION IF EXISTS public.daily_choice_admin_get(uuid[]);
DROP FUNCTION IF EXISTS public.daily_choice_admin_list(text, integer, integer);
DROP FUNCTION IF EXISTS public.daily_choice_finish(uuid, integer, timestamptz);
DROP FUNCTION IF EXISTS public.daily_choice_start(uuid);
DROP FUNCTION IF EXISTS public.daily_record_participation(uuid, timestamptz, integer);
DROP FUNCTION IF EXISTS public.daily_choice_new_perm();
DROP FUNCTION IF EXISTS public.daily_choice_fmt(text);
DROP TABLE IF EXISTS public.daily_choice_sessions;
DROP TABLE IF EXISTS public.daily_choice_sets;

-- placar: volta à assinatura anterior (sem p_mode, sem a coluna mode)
DROP FUNCTION IF EXISTS public.get_daily_leaderboard(integer, text);
CREATE OR REPLACE FUNCTION public.get_daily_leaderboard(p_limit integer DEFAULT 20)
RETURNS TABLE (user_id uuid, score integer, is_correct boolean, time_seconds integer)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $$
  SELECT user_id, score, is_correct, time_seconds
  FROM public.daily_attempts
  WHERE challenge_hour = date_trunc('hour', now())
  ORDER BY score DESC, time_seconds ASC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;
REVOKE ALL ON FUNCTION public.get_daily_leaderboard(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_leaderboard(integer) TO authenticated, service_role;

-- revisão do jogador: definição anterior (sem mode/daily_mode)
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

-- sorteio: definição anterior (sem o filtro published e sem o modo escolha)
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

-- multiplayer: choose_word e get_random_word_prompts voltam às definições anteriores
-- (20261025140000 e 20260720110000) e a leitura de daily_challenges volta a incluir a hora corrente
CREATE OR REPLACE FUNCTION public.choose_word(p_room_id uuid, p_word_id uuid, p_duration_sec integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'choosing' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;
  IF v_room.current_word_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_chosen'); END IF;

  UPDATE public.rooms
  SET status = 'writing',
      current_word_id = p_word_id,
      used_word_ids = CASE
        WHEN p_word_id = ANY(used_word_ids) THEN used_word_ids
        ELSE array_append(used_word_ids, p_word_id)
      END,
      -- escrita: base + 10 s, sem escalar com a sala (2026-10-25)
      round_phase_ends_at = now() + make_interval(secs => public.writing_phase_secs(p_duration_sec)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_random_word_prompts(
  exclude_ids uuid[] DEFAULT ARRAY[]::uuid[],
  min_rarity integer DEFAULT 2,
  lim integer DEFAULT 3,
  p_categories text[] DEFAULT ARRAY[]::text[],
  p_nivel text DEFAULT NULL
)
RETURNS TABLE(id uuid, word text, category text, rarity int, nivel text, classe text, pronuncia text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT w.id, w.word, w.category, w.rarity, w.nivel, w.classe, w.pronuncia
  FROM public.get_random_words(exclude_ids, min_rarity, lim, p_categories, p_nivel) AS w;
$function$;

DROP POLICY IF EXISTS "daily_challenges past read" ON public.daily_challenges;
CREATE POLICY "public read daily_challenges" ON public.daily_challenges
  FOR SELECT USING (true);  -- política anterior (20260520100117)
DROP FUNCTION IF EXISTS public.daily_current_word_id();

DROP FUNCTION IF EXISTS public.daily_mode();
ALTER TABLE public.daily_attempts DROP CONSTRAINT IF EXISTS daily_attempts_mode_check;
ALTER TABLE public.daily_attempts DROP COLUMN IF EXISTS mode;
DELETE FROM public.app_config WHERE key = 'daily_mode';
