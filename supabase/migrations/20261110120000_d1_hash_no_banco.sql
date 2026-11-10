-- D1 — endurecimento editorial no BANCO (ressalva R1 do PR #52, + trava atômica da R3).
--
-- R1: a aprovação por manifesto conferia o hash só no Worker; entre a conferência e o
--     UPDATE, outro admin podia trocar as alternativas e a troca seria aprovada.
--     Agora o próprio banco recalcula o hash v1 na MESMA transação do UPDATE, com as
--     linhas travadas: só vira "aprovado" o que é exatamente o revisado.
-- R3: editar um conjunto APROVADO só com pedido explícito (p_allow_approved), decidido
--     com a linha travada (fecha a corrida entre "ler o estado" e "gravar").
-- R4: idem para REPROVADO (p_allow_rejected): editar o devolveria a rascunho e o
--     deixaria pronto para a aprovação em lote do manifesto.
-- R2: alternativa com quebra de linha ou caractere de controle não é gravada nem aprovada.
--
-- Compatibilidade: as funções antigas (daily_choice_admin_review / _edit) NÃO mudam;
-- as novas têm nome próprio. O Worker em produção continua funcionando igual antes
-- e depois desta migration; o código novo só passa a usar as novas depois dela.
-- Nenhuma tabela, coluna, dado ou permissão de jogador muda. Rollback:
-- supabase/rollback/d1_hash_no_banco.sql (só DROP das 4 funções novas).

-- 1) Hash v1 do conjunto: SHA-256 hex de
--    "verbete-d1-v1\n<word_id>\n<definição>\n<alt1>\n<alt2>\n<alt3>" (UTF-8).
--    Igual a setHash() em src/lib/daily-choice-manifest.ts para alternativas já
--    aparadas (o servidor sempre grava aparado). Alternativa com espaço nas pontas
--    dá hash diferente do Worker e é RECUSADA (falha fechada, nunca aprova a mais).
CREATE OR REPLACE FUNCTION public.daily_choice_set_hash(p_word_id uuid, p_truth text, p_distractors text[])
RETURNS text
LANGUAGE sql STABLE STRICT
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT encode(sha256(convert_to(
           'verbete-d1-v1' || E'\n' || p_word_id::text || E'\n' || p_truth
           || E'\n' || p_distractors[1] || E'\n' || p_distractors[2] || E'\n' || p_distractors[3],
           'UTF8')), 'hex')
   WHERE array_length(p_distractors, 1) = 3
$$;

-- 2) Exatamente 3 alternativas, nenhuma nula, vazia ou com quebra de linha /
--    caractere de controle (U+0000–U+001F, U+007F, U+2028, U+2029).
CREATE OR REPLACE FUNCTION public.daily_choice_alt_ok(p_distractors text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT coalesce(array_length(p_distractors, 1), 0) = 3
     AND NOT EXISTS (
           SELECT 1 FROM unnest(p_distractors) AS d(t)
            WHERE d.t IS NULL OR d.t = '' OR d.t ~ '[\x01-\x1f\x7f\u2028\u2029]')
$$;

-- 3) Aprovação por manifesto com o hash conferido DENTRO do banco.
--    p_expected = {"<word_id>": "<hash revisado>", ...} (1 a 200).
--    Aprova só quem: está em RASCUNHO (não desfaz reprovação: R4), palavra publicada,
--    definição igual à revisada, validador OK, alternativas válidas e hash atual =
--    hash revisado. As linhas são travadas antes (conjunto FOR UPDATE, palavra FOR
--    SHARE, em ordem de id): ninguém troca alternativa nem definição no meio.
CREATE OR REPLACE FUNCTION public.daily_choice_admin_review_hashed(p_expected jsonb, p_reviewer uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer; v_req integer; v_ids uuid[];
BEGIN
  IF p_reviewer IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'daily_choice_admin_review_hashed: entrada inválida' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_req FROM jsonb_object_keys(p_expected);
  IF v_req = 0 OR v_req > 200 OR EXISTS (
       SELECT 1 FROM jsonb_each(p_expected) e
        WHERE e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'string'
           OR (e.value #>> '{}') !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'daily_choice_admin_review_hashed: entrada inválida' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(k::uuid ORDER BY k) INTO v_ids FROM jsonb_object_keys(p_expected) AS k;

  PERFORM 1
     FROM public.daily_choice_sets s JOIN public.words w ON w.id = s.word_id
    WHERE s.word_id = ANY (v_ids)
    ORDER BY s.word_id
      FOR UPDATE OF s FOR SHARE OF w;

  UPDATE public.daily_choice_sets s
     SET status = 'aprovado', reviewed_by = p_reviewer, reviewed_at = now(), updated_at = now()
    FROM public.words w, jsonb_each_text(p_expected) AS e(word_id, hash)
   WHERE s.word_id = e.word_id::uuid AND w.id = s.word_id
     AND s.status = 'rascunho'
     AND w.status = 'published'
     AND w.meaning = s.truth_snapshot
     AND (s.validacao ->> 'ok') = 'true'
     AND public.daily_choice_alt_ok(s.distractors)
     AND public.daily_choice_set_hash(s.word_id, w.meaning, s.distractors) = e.hash;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_n, 'skipped', v_req - v_n);
END $$;

-- 4) Edição com trava: APROVADO só muda com p_allow_approved = true e REPROVADO só com
--    p_allow_rejected = true (decidido com a linha travada). Mesmo efeito da edição
--    antiga: volta a RASCUNHO e atualiza a definição revisada.
CREATE OR REPLACE FUNCTION public.daily_choice_admin_edit_guarded(
  p_word_id uuid, p_distractors text[], p_validacao jsonb, p_allow_approved boolean, p_allow_rejected boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer; v_status text;
BEGIN
  IF NOT public.daily_choice_alt_ok(p_distractors) THEN
    RAISE EXCEPTION 'daily_choice_admin_edit_guarded: são precisos 3 distratores, sem quebra de linha'
      USING ERRCODE = '22023';
  END IF;
  SELECT s.status INTO v_status FROM public.daily_choice_sets s WHERE s.word_id = p_word_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', 0);
  END IF;
  IF v_status = 'aprovado' AND p_allow_approved IS NOT TRUE THEN
    RETURN jsonb_build_object('updated', 0, 'blocked', 'aprovado');
  END IF;
  IF v_status = 'reprovado' AND p_allow_rejected IS NOT TRUE THEN
    RETURN jsonb_build_object('updated', 0, 'blocked', 'reprovado');
  END IF;
  UPDATE public.daily_choice_sets s
     SET distractors = p_distractors, validacao = coalesce(p_validacao, '{}'::jsonb),
         truth_snapshot = w.meaning, status = 'rascunho', reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
    FROM public.words w
   WHERE s.word_id = p_word_id AND w.id = s.word_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_n);
END $$;

-- 5) Permissões: só o servidor (service_role). Jogador e anônimo: nada.
REVOKE ALL ON FUNCTION public.daily_choice_set_hash(uuid, text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_alt_ok(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_admin_review_hashed(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_admin_edit_guarded(uuid, text[], jsonb, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daily_choice_set_hash(uuid, text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_alt_ok(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_review_hashed(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_edit_guarded(uuid, text[], jsonb, boolean, boolean) TO service_role;
