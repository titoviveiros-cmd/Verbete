-- B6 — ECA Digital (Lei 15.211/2025): ranking público só para quem ATIVA.
--   (a) art. 7º (configuração mais protetiva por padrão) e art. 8º IV (evitar
--       uso compulsivo); (b) leitura: ranking com nome = exposição a terceiros
--       que precisa de escolha do titular (confiança moderada, Q7 do parecer).
--   (c) decisão de produto: padrão DESLIGADO para TODOS, inclusive contas
--       antigas (ninguém continua público sem ter escolhido).
--
-- O que muda (arquivo apenas: NÃO aplicado em lugar nenhum; rollback em
-- supabase/rollback/ranking_opt_in.sql):
--   1) profiles.ranking_opt_in boolean NOT NULL DEFAULT false.
--   2) Leitura direta de profiles (PostgREST): só a própria linha ou a de quem
--      optou. Antes, qualquer sessão autenticada (inclusive convidado anônimo)
--      lia o nome de TODOS os perfis.
--   3) get_ranking_top: só quem optou (+ a própria linha, que só o dono vê).
--   4) get_daily_leaderboard: idem.
--
-- Compatibilidade com o APK vc8 (2.1.4; bundle offline, não sabe do opt-in):
--   * chama get_ranking_top(p_limit => 50) e get_daily_leaderboard(p_limit => 20)
--     e depois lê profiles .in(user_id, ids) — as ASSINATURAS e as colunas de
--     retorno ficam IGUAIS (CREATE OR REPLACE, sem DROP), então o vc8 só passa a
--     receber menos linhas. Nenhum grant muda (CREATE OR REPLACE preserva).
--   * no vc8 não há como ativar: quem só usa o vc8 fica fora do ranking até
--     atualizar ou ativar pelo web (aceito: é o padrão protetivo).
--   * o vc8 edita o próprio nome por UPDATE em profiles (política "self
--     update", inalterada) e lê o próprio perfil (permitido pela política nova).

-- 1) coluna ---------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ranking_opt_in boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.ranking_opt_in IS
  'ECA Digital (B6): true = o titular escolheu aparecer nos rankings públicos. Padrão false; desligar a qualquer momento no Perfil/Ranking.';

-- 2) leitura direta: o próprio perfil ou quem optou -----------------------------
DROP POLICY IF EXISTS "profiles authenticated read" ON public.profiles;
DROP POLICY IF EXISTS "profiles self or ranking read" ON public.profiles;
CREATE POLICY "profiles self or ranking read" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR ranking_opt_in);

-- 3) ranking global (Top 50) ----------------------------------------------------
--    Mesmo corpo de 20260607220240, com JOIN (não LEFT JOIN: sem perfil não há
--    escolha) e o filtro do opt-in. auth.uid() é NULL para anon: só quem optou.
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
  JOIN public.profiles p ON p.user_id = s.user_id
  WHERE s.total_score > 0
    AND (p.ranking_opt_in OR s.user_id = auth.uid())
  ORDER BY s.total_score DESC, s.games_won DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 200);
$$;

-- 4) placar do Diário -----------------------------------------------------------
--    Mesmo corpo de 20261108120000 (D1, com o modo), mais o filtro do opt-in.
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
    AND (a.user_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p
                     WHERE p.user_id = a.user_id AND p.ranking_opt_in))
  ORDER BY a.score DESC, a.time_seconds ASC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;
