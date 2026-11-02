-- =============================================================================
-- 2.1.4 — "🤏 Quase lá! Faltou precisão." para o AUTOR de uma definição que o
-- juiz 🧠 (score-similarity) deu nota 50–79. Juiz, rubrica, limiar 80 e bônus
-- +3 intocados: 80+ segue em apply_similarity_bonus (near_truth).
--
-- Só a MARCA fica guardada (nunca a nota), numa tabela sem acesso de client:
-- a edge grava com service_role (apply_similarity_near_miss, idempotente, presa
-- à sala/rodada); o autor lê só a própria marca da rodada atual, com a
-- identidade conferida, e só a partir da revelação (get_my_near_miss).
-- Falha da IA = nenhuma marca = nenhuma mensagem (nunca vira "nota baixa").
-- Some junto com a definição (CASCADE) — inclusive na retenção das salas.
-- ROLLBACK: supabase/rollback/judge_near_miss.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.definition_near_miss (
  definition_id uuid PRIMARY KEY REFERENCES public.definitions(id) ON DELETE CASCADE,
  room_id uuid NOT NULL,
  round int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.definition_near_miss ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.definition_near_miss FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_similarity_near_miss(
  p_room_id uuid,
  p_round int,
  p_definition_ids uuid[]
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_n int;
BEGIN
  INSERT INTO public.definition_near_miss (definition_id, room_id, round)
  SELECT d.id, d.room_id, d.round
    FROM public.definitions d
   WHERE d.id = ANY (coalesce(p_definition_ids, '{}'))
     AND d.room_id = p_room_id
     AND d.round = p_round
     AND d.is_truth = false
     AND d.near_truth = false  -- 80+ ganhou o bônus: não é "quase"
  ON CONFLICT (definition_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_similarity_near_miss(uuid, int, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_similarity_near_miss(uuid, int, uuid[]) TO service_role;

-- O autor (identidade conferida) pergunta pela PRÓPRIA definição da rodada
-- atual. Antes da revelação devolve false (nada vaza na escrita/votação).
CREATE OR REPLACE FUNCTION public.get_my_near_miss(p_room_id uuid, p_player_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_room public.rooms;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.status NOT IN ('reveal', 'scoreboard', 'finished') THEN
    RETURN false;
  END IF;
  IF public.assert_actor_identity(p_room_id, p_player_id) IS NOT NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.definition_near_miss n
      JOIN public.definitions d ON d.id = n.definition_id
     WHERE n.room_id = p_room_id
       AND n.round = v_room.current_round
       AND d.player_id = p_player_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_near_miss(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_near_miss(uuid, text) TO anon, authenticated;
