-- =====================================================================
-- Fase 2A da auditoria: protege votação contra trapaça
-- =====================================================================

CREATE OR REPLACE FUNCTION public.cast_vote(
  p_room_id uuid,
  p_voter_id text,
  p_definition_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_room public.rooms;
  v_def public.definitions;
BEGIN
  IF p_room_id IS NULL OR p_voter_id IS NULL OR p_definition_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'voting' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  END IF;

  -- Jogador precisa pertencer à sala e não estar expulso.
  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_voter_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;

  -- Definição precisa ser da rodada atual desta sala.
  SELECT * INTO v_def FROM public.definitions WHERE id = p_definition_id;
  IF v_def IS NULL
     OR v_def.room_id <> p_room_id
     OR v_def.round <> v_room.current_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'definition_not_in_round');
  END IF;

  -- Não pode votar na própria definição.
  IF v_def.player_id = p_voter_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cannot_vote_own');
  END IF;

  -- Upsert atômico — um voto por (sala, rodada, jogador).
  INSERT INTO public.votes (room_id, round, voter_id, definition_id)
  VALUES (p_room_id, v_room.current_round, p_voter_id, p_definition_id)
  ON CONFLICT (room_id, round, voter_id)
    DO UPDATE SET definition_id = EXCLUDED.definition_id,
                  created_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cast_vote(uuid, text, uuid) TO anon, authenticated;

-- Bots disparam vários votos numa única chamada (do cliente do host).
-- Mantemos a mesma validação, mas em lote.
CREATE OR REPLACE FUNCTION public.cast_votes_bulk(
  p_room_id uuid,
  p_round integer,
  p_votes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_room public.rooms;
  v_inserted int := 0;
  v_row jsonb;
  v_voter text;
  v_def_id uuid;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.status <> 'voting' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_votes, '[]'::jsonb))
  LOOP
    v_voter := v_row->>'voter_id';
    v_def_id := NULLIF(v_row->>'definition_id', '')::uuid;
    IF v_voter IS NULL OR v_def_id IS NULL THEN CONTINUE; END IF;

    -- Apenas bots desta sala podem ser inseridos em lote.
    IF NOT EXISTS (
      SELECT 1 FROM public.players
      WHERE id = v_voter AND room_id = p_room_id AND is_bot = true AND kicked_at IS NULL
    ) THEN CONTINUE; END IF;

    -- Definição precisa ser da rodada e não pertencer ao próprio votante.
    IF NOT EXISTS (
      SELECT 1 FROM public.definitions d
      WHERE d.id = v_def_id
        AND d.room_id = p_room_id
        AND d.round = p_round
        AND d.player_id <> v_voter
    ) THEN CONTINUE; END IF;

    INSERT INTO public.votes (room_id, round, voter_id, definition_id)
    VALUES (p_room_id, p_round, v_voter, v_def_id)
    ON CONFLICT (room_id, round, voter_id) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cast_votes_bulk(uuid, integer, jsonb) TO anon, authenticated;

-- =====================================================================
-- Fecha as policies de votes para escrita pública.
-- Apenas as RPCs SECURITY DEFINER acima podem inserir/atualizar.
-- A leitura pública continua aberta (placar/revelação dependem dela).
-- =====================================================================
DROP POLICY IF EXISTS "votes public insert" ON public.votes;
DROP POLICY IF EXISTS "votes public delete" ON public.votes;

-- A função `reset_room` (SECURITY DEFINER) já apaga votos via `DELETE` direto;
-- nada no cliente precisa apagar votos. Não recriamos policy de DELETE.


