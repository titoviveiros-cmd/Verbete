-- ROLLBACK de 20261111154500_ranking_opt_in.sql (B6, ranking opt-in).
-- Volta ao estado anterior: ranking com TODOS os que pontuaram e leitura de
-- profiles por qualquer sessão autenticada. ATENÇÃO: o passo 4 apaga a coluna
-- e, com ela, as escolhas de quem ativou (rodar só com decisão do dono).
--   npx supabase db query --linked -f supabase/rollback/ranking_opt_in.sql
-- (sem BEGIN/COMMIT próprios, como os demais: quem roda decide a transação)

-- 1) get_ranking_top = corpo de 20260607220240
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

-- 2) get_daily_leaderboard = corpo de 20261108120000 (D1)
CREATE OR REPLACE FUNCTION public.get_daily_leaderboard(p_limit integer DEFAULT 20, p_mode text DEFAULT NULL)
RETURNS TABLE (user_id uuid, score integer, is_correct boolean, time_seconds integer, mode text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $$
  WITH m AS (
    SELECT CASE WHEN p_mode IN ('juiz', 'escolha') THEN p_mode
                WHEN p_mode IS NULL AND public.daily_mode() IN ('juiz', 'escolha') THEN public.daily_mode()
           END AS mode
  )
  SELECT a.user_id, a.score, a.is_correct, a.time_seconds, a.mode
  FROM public.daily_attempts a, m
  WHERE a.challenge_hour = date_trunc('hour', now())
    AND (m.mode IS NULL OR a.mode = m.mode)
  ORDER BY a.score DESC, a.time_seconds ASC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

-- 3) leitura de profiles = política de 20260519024409
DROP POLICY IF EXISTS "profiles self or ranking read" ON public.profiles;
DROP POLICY IF EXISTS "profiles authenticated read" ON public.profiles;
CREATE POLICY "profiles authenticated read" ON public.profiles
  FOR SELECT TO authenticated USING (true);

-- 4) coluna (depois das funções e da política, que dependem dela)
ALTER TABLE public.profiles DROP COLUMN IF EXISTS ranking_opt_in;

