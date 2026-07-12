
-- 1) profiles: restringir leitura a usuários autenticados
DROP POLICY IF EXISTS "profiles public read" ON public.profiles;
CREATE POLICY "profiles authenticated read" ON public.profiles
  FOR SELECT TO authenticated USING (true);

-- 2) user_stats: restringir leitura a usuários autenticados (necessário para ranking)
DROP POLICY IF EXISTS "user_stats public read" ON public.user_stats;
CREATE POLICY "user_stats authenticated read" ON public.user_stats
  FOR SELECT TO authenticated USING (true);

-- 3) user_achievements: só o próprio dono
DROP POLICY IF EXISTS "user_achievements public read" ON public.user_achievements;
CREATE POLICY "user_achievements self read" ON public.user_achievements
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- 4) daily_attempts: só o próprio dono lê a linha completa (inclui o "guess")
DROP POLICY IF EXISTS "daily_attempts public read" ON public.daily_attempts;
CREATE POLICY "daily_attempts self read" ON public.daily_attempts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Placar do dia: visão limitada sem o campo "guess"
CREATE OR REPLACE VIEW public.daily_leaderboard
WITH (security_invoker = on) AS
SELECT user_id, challenge_hour, score, is_correct, time_seconds
FROM public.daily_attempts;

-- Para a view funcionar via security_invoker precisamos de uma policy permissiva
-- só nas colunas seguras quando o leitor está autenticado.
CREATE POLICY "daily_attempts leaderboard read" ON public.daily_attempts
  FOR SELECT TO authenticated USING (true);
-- ^ permitiria ler "guess" — não queremos. Vamos remover e usar SECURITY DEFINER no view.
DROP POLICY "daily_attempts leaderboard read" ON public.daily_attempts;

-- Recria a view como SECURITY DEFINER (executa com privilégios do owner, ignorando RLS),
-- expondo só as colunas seguras.
DROP VIEW IF EXISTS public.daily_leaderboard;
CREATE VIEW public.daily_leaderboard
WITH (security_invoker = off) AS
SELECT user_id, challenge_hour, score, is_correct, time_seconds
FROM public.daily_attempts;

REVOKE ALL ON public.daily_leaderboard FROM PUBLIC, anon;
GRANT SELECT ON public.daily_leaderboard TO authenticated;

-- 5) daily_challenges: só revelar desafios cujo horário já chegou
DROP POLICY IF EXISTS "daily_challenges public read" ON public.daily_challenges;
CREATE POLICY "daily_challenges past read" ON public.daily_challenges
  FOR SELECT TO anon, authenticated USING (challenge_hour <= now());

-- 6) RPCs SECURITY DEFINER: validar auth.uid() e revogar EXECUTE de anon
CREATE OR REPLACE FUNCTION public.submit_daily_attempt(
  p_user_id uuid, p_guess text, p_time_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  -- delega para a implementação interna preservando comportamento existente
  SELECT public._submit_daily_attempt_impl(p_user_id, p_guess, p_time_seconds) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_user_stats(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  DELETE FROM public.daily_attempts WHERE user_id = p_user_id;
  DELETE FROM public.match_history WHERE user_id = p_user_id;
  DELETE FROM public.user_achievements WHERE user_id = p_user_id;
  DELETE FROM public.user_stats WHERE user_id = p_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_daily_attempt(uuid, text, integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_daily_attempt(uuid, text, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.reset_user_stats(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_user_stats(uuid) TO authenticated;


