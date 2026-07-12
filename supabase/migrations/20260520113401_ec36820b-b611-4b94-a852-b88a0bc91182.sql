-- Revogar acesso direto às colunas sensíveis (anti-cheat)
REVOKE SELECT (is_truth, near_truth) ON public.definitions FROM anon, authenticated;

-- RPC: devolve truth + near_truth IDs, mas só quando a rodada já terminou
CREATE OR REPLACE FUNCTION public.get_round_reveal(p_room_id uuid, p_round int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_truth_id uuid;
  v_near_ids uuid[];
BEGIN
  SELECT status INTO v_status FROM public.rooms WHERE id = p_room_id;
  IF v_status IS NULL OR v_status NOT IN ('reveal','scoreboard','finished') THEN
    RETURN jsonb_build_object('available', false);
  END IF;

  SELECT id INTO v_truth_id FROM public.definitions
   WHERE room_id = p_room_id AND round = p_round AND is_truth = true LIMIT 1;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_near_ids
   FROM public.definitions
   WHERE room_id = p_room_id AND round = p_round AND near_truth = true;

  RETURN jsonb_build_object(
    'available', true,
    'truth_def_id', v_truth_id,
    'near_truth_ids', v_near_ids
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_round_reveal(uuid, int) TO anon, authenticated;

-- RPC: devolve para a sala inteira (todas as rodadas) — usado no Scoreboard final
CREATE OR REPLACE FUNCTION public.get_room_reveal(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM public.rooms WHERE id = p_room_id;
  IF v_status IS NULL OR v_status NOT IN ('reveal','scoreboard','finished') THEN
    RETURN jsonb_build_object('available', false);
  END IF;

  RETURN jsonb_build_object(
    'available', true,
    'truth_def_ids', COALESCE((
      SELECT array_agg(id) FROM public.definitions
       WHERE room_id = p_room_id AND is_truth = true
    ), ARRAY[]::uuid[]),
    'near_truth_ids', COALESCE((
      SELECT array_agg(id) FROM public.definitions
       WHERE room_id = p_room_id AND near_truth = true
    ), ARRAY[]::uuid[])
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_room_reveal(uuid) TO anon, authenticated;

