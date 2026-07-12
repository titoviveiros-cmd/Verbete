-- =====================================================================
-- Fase 2B.1: protege INSERT em definitions
-- =====================================================================

-- Definição de jogador humano
CREATE OR REPLACE FUNCTION public.submit_definition(
  p_room_id uuid,
  p_player_id text,
  p_text text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_room public.rooms;
  v_clean text;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL OR p_text IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  v_clean := substring(btrim(p_text) from 1 for 140);
  IF char_length(v_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_text');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  END IF;
  IF v_room.current_coordinator = p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'coordinator_cannot_write');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_player_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;

  INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
  VALUES (p_room_id, v_room.current_round, p_player_id, v_clean, false)
  ON CONFLICT (room_id, round, player_id)
    DO UPDATE SET text = EXCLUDED.text, created_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_definition(uuid, text, text) TO anon, authenticated;

-- Definições dos bots (host envia em lote)
CREATE OR REPLACE FUNCTION public.submit_bot_definitions_bulk(
  p_room_id uuid,
  p_round integer,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_room public.rooms;
  v_row jsonb;
  v_pid text;
  v_text text;
  v_inserted int := 0;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.status <> 'writing' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    v_pid := v_row->>'player_id';
    v_text := substring(btrim(COALESCE(v_row->>'text', '')) from 1 for 140);
    IF v_pid IS NULL OR char_length(v_text) = 0 THEN CONTINUE; END IF;

    -- Só aceita bots desta sala
    IF NOT EXISTS (
      SELECT 1 FROM public.players
      WHERE id = v_pid AND room_id = p_room_id AND is_bot = true AND kicked_at IS NULL
    ) THEN CONTINUE; END IF;

    INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
    VALUES (p_room_id, p_round, v_pid, v_text, false)
    ON CONFLICT (room_id, round, player_id) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_bot_definitions_bulk(uuid, integer, jsonb) TO anon, authenticated;

-- Inserção da definição verdadeira (chamada pelo host na transição p/ votação)
CREATE OR REPLACE FUNCTION public.insert_truth_definition(
  p_room_id uuid,
  p_round integer,
  p_text text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_room public.rooms;
  v_clean text;
  v_id uuid;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  -- Aceita inserir a verdade durante shuffling/voting (transição) ou writing tardio
  IF v_room.current_round <> p_round
     OR v_room.status NOT IN ('writing', 'shuffling', 'voting') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  v_clean := substring(btrim(COALESCE(p_text, '')) from 1 for 200);
  IF char_length(v_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_text');
  END IF;

  INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
  VALUES (p_room_id, p_round, '__truth__', v_clean, true)
  ON CONFLICT (room_id, round, player_id)
    DO UPDATE SET text = EXCLUDED.text
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.insert_truth_definition(uuid, integer, text) TO anon, authenticated;

-- Fecha INSERT direto em definitions
DROP POLICY IF EXISTS "definitions public insert" ON public.definitions;


