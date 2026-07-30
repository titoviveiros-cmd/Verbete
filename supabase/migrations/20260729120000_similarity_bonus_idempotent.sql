-- Auditoria externa (2026-07-29), achado crítico: apply_similarity_bonus
-- somava +3 a cada chamada repetida (a marcação near_truth tinha guarda,
-- a soma não) e não exigia sala/rodada. Combinada com a edge function
-- pública score-similarity, permitia inflar pontuação por replay.
--
-- Correção: nova assinatura (room, round, ids) onde marcação e soma são
-- UMA operação atômica — só ganha +3 a definição recém-marcada, daquela
-- sala/rodada, que não é a verdade. A assinatura antiga vira no-op
-- deprecado (padrão do projeto: revogar comportamento, não dropar).
--
-- ROLLBACK: DROP FUNCTION public.apply_similarity_bonus(uuid, int, uuid[]);
-- reaplicar o corpo antigo da assinatura de 1 argumento (migration
-- 20260720100000).

CREATE OR REPLACE FUNCTION public.apply_similarity_bonus(
  p_room_id uuid,
  p_round int,
  p_definition_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int;
BEGIN
  IF p_room_id IS NULL OR p_round IS NULL
     OR p_definition_ids IS NULL OR array_length(p_definition_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'bumped', 0);
  END IF;

  -- Atômico: quem NÃO estava near_truth vira near_truth AGORA e é o único
  -- que pontua. Replays acham near_truth=true e não retornam linhas.
  WITH marked AS (
    UPDATE public.definitions d
    SET near_truth = true
    WHERE d.id = ANY(p_definition_ids)
      AND d.room_id = p_room_id
      AND d.round = p_round
      AND d.is_truth = false
      AND d.player_id <> '__truth__'
      AND d.near_truth IS DISTINCT FROM true
    RETURNING d.player_id
  ),
  por_jogador AS (
    SELECT player_id, count(*) AS n FROM marked GROUP BY player_id
  ),
  bumped AS (
    UPDATE public.players p
    SET score = p.score + 3 * pj.n
    FROM por_jogador pj
    WHERE p.id = pj.player_id AND p.room_id = p_room_id
    RETURNING p.id
  )
  SELECT count(*) INTO v_count FROM bumped;

  RETURN jsonb_build_object('ok', true, 'bumped', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_similarity_bonus(uuid, int, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_similarity_bonus(uuid, int, uuid[]) TO service_role;

-- Assinatura antiga: no-op deprecado (a edge é atualizada em conjunto).
CREATE OR REPLACE FUNCTION public.apply_similarity_bonus(p_definition_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RAISE WARNING 'apply_similarity_bonus(uuid[]) deprecada — use (room_id, round, ids)';
  RETURN jsonb_build_object('ok', false, 'reason', 'deprecated_signature');
END;
$$;
