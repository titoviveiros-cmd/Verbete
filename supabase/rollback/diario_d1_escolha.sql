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
DROP FUNCTION IF EXISTS public.daily_choice_finish(uuid, integer);
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

DROP FUNCTION IF EXISTS public.daily_mode();
ALTER TABLE public.daily_attempts DROP CONSTRAINT IF EXISTS daily_attempts_mode_check;
ALTER TABLE public.daily_attempts DROP COLUMN IF EXISTS mode;
DELETE FROM public.app_config WHERE key = 'daily_mode';
