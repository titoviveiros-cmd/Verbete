-- Rollback de 20261110180000_d1_r6b_aprovar_so_por_hash.sql: devolve a daily_choice_admin_review
-- EXATAMENTE como estava (corpo copiado de 20261108120000_diario_d1_escolha.sql), o que volta
-- a permitir aprovar SEM hash pela função antiga (a ressalva R6b reabre no banco).
-- Nenhum dado, tabela ou outra função é tocado. Permissões: as mesmas (reafirmadas).
-- O Worker do R6 continua funcionando igual (nunca manda "aprovado" para esta função).
-- ORDEM: este rollback vem ANTES do da R1 (d1_hash_no_banco.sql). Ele não apaga a linha da
-- R6b em supabase_migrations.schema_migrations (padrão do repo: registrar à parte).
CREATE OR REPLACE FUNCTION public.daily_choice_admin_review(p_word_ids uuid[], p_status text, p_reviewer uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer; v_req integer := coalesce(array_length(p_word_ids, 1), 0);
BEGIN
  IF p_status NOT IN ('aprovado', 'reprovado', 'rascunho') OR p_reviewer IS NULL OR v_req = 0 OR v_req > 200 THEN
    RAISE EXCEPTION 'daily_choice_admin_review: entrada inválida' USING ERRCODE = '22023';
  END IF;
  UPDATE public.daily_choice_sets s
     SET status = p_status,
         reviewed_by = CASE WHEN p_status = 'rascunho' THEN NULL ELSE p_reviewer END,
         reviewed_at = CASE WHEN p_status = 'rascunho' THEN NULL ELSE now() END,
         updated_at = now()
    FROM public.words w
   WHERE s.word_id = ANY (p_word_ids) AND w.id = s.word_id
     AND (p_status <> 'aprovado'
          OR (w.status = 'published' AND w.meaning = s.truth_snapshot AND (s.validacao ->> 'ok') = 'true'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_n, 'skipped', v_req - v_n);
END $$;

COMMENT ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) IS NULL;
REVOKE ALL ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) TO service_role;
