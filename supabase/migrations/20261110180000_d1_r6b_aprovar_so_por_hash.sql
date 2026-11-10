-- D1 — R6b: no BANCO, aprovar só por hash (ressalva do PR #57).
--
-- Depois do PR #57 o Worker nunca aprova pela função antiga (oldReviewStatus recusa
-- 'aprovado' antes da chamada), mas a própria função daily_choice_admin_review ainda
-- aceitava 'aprovado' sem conferir o conteúdo. Um Worker anterior ao R6 (rollback para
-- ede242c3 ou bc4a1cf5) ou qualquer código novo que a chamasse reabriria a aprovação
-- "às cegas". Agora o banco recusa: 'aprovado' só por daily_choice_admin_review_hashed
-- (R1, 20261110120000), que recalcula o hash com a linha travada.
--
-- O que muda: SÓ o corpo de daily_choice_admin_review (mesma assinatura, mesmo retorno,
-- mesmas permissões). Reprovar e voltar a rascunho seguem iguais, byte a byte no efeito.
-- Nenhuma tabela, coluna, dado, índice ou permissão muda. Tipos gerados não mudam.
--
-- Compatibilidade de Worker (falha FECHADA, nunca aprova a mais):
--   * Worker com o R6 (master 3f01726 em diante): nenhuma mudança visível.
--   * Worker anterior (ede242c3, hoje em produção): o "✅ Aprovar" do painel principal
--     passa a dar erro "daily_choice_admin_review 42501" (nada é gravado); o manifesto
--     segue aprovando por hash. Ordem recomendada: publicar o Worker do R6 ANTES.
--   * Rollback do Worker para bc4a1cf5 (anterior ao R1): toda aprovação falha; reprovar
--     e voltar a rascunho seguem funcionando.
-- Rollback: supabase/rollback/d1_r6b_aprovar_so_por_hash.sql (devolve o corpo anterior).
-- Ordem dos rollbacks: desfazer a R6b ANTES da R1 (sem a R1 e com a R6b, nada aprova).

-- 0) Pré-condição: a aprovação por hash (R1) existe e a função antiga não tem sobrecarga.
--    Sem isso, esta migration pararia toda aprovação; então ela mesma se recusa a rodar.
DO $$
BEGIN
  IF to_regprocedure('public.daily_choice_admin_review_hashed(jsonb,uuid)') IS NULL THEN
    RAISE EXCEPTION 'R6b: daily_choice_admin_review_hashed ausente (aplique a R1 20261110120000 antes)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'daily_choice_admin_review') <> 1 THEN
    RAISE EXCEPTION 'R6b: esperava exatamente 1 daily_choice_admin_review em public';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.daily_choice_admin_review(p_word_ids uuid[], p_status text, p_reviewer uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer; v_req integer := coalesce(array_length(p_word_ids, 1), 0);
BEGIN
  IF p_status = 'aprovado' THEN
    RAISE EXCEPTION 'daily_choice_admin_review: aprovar só por hash (daily_choice_admin_review_hashed)'
      USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('reprovado', 'rascunho') OR p_reviewer IS NULL OR v_req = 0 OR v_req > 200 THEN
    RAISE EXCEPTION 'daily_choice_admin_review: entrada inválida' USING ERRCODE = '22023';
  END IF;
  UPDATE public.daily_choice_sets s
     SET status = p_status,
         reviewed_by = CASE WHEN p_status = 'rascunho' THEN NULL ELSE p_reviewer END,
         reviewed_at = CASE WHEN p_status = 'rascunho' THEN NULL ELSE now() END,
         updated_at = now()
    FROM public.words w
   WHERE s.word_id = ANY (p_word_ids) AND w.id = s.word_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_n, 'skipped', v_req - v_n);
END $$;

COMMENT ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) IS
  'D1: só reprova ou volta a rascunho. Aprovar = daily_choice_admin_review_hashed (R1/R6b).';

-- Permissões: CREATE OR REPLACE preserva as atuais; reafirmadas aqui (idempotente).
REVOKE ALL ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) TO service_role;
