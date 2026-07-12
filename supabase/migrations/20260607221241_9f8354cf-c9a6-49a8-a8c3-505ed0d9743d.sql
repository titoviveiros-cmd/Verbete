-- 1) kick_player: só host pode expulsar
CREATE OR REPLACE FUNCTION public.kick_player(
  p_room_id uuid,
  p_actor_id text,
  p_target_player_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room public.rooms;
BEGIN
  IF p_room_id IS NULL OR p_actor_id IS NULL OR p_target_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.host_id <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_host');
  END IF;
  IF p_target_player_id = p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cannot_kick_self');
  END IF;

  -- No lobby, remove definitivamente (não há histórico ainda).
  IF v_room.status = 'lobby' THEN
    DELETE FROM public.players
      WHERE id = p_target_player_id AND room_id = p_room_id;
  ELSE
    UPDATE public.players
       SET kicked_at = now(), is_connected = false
     WHERE id = p_target_player_id AND room_id = p_room_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.kick_player(uuid, text, text) TO anon, authenticated;

-- 2) leave_room: o próprio jogador sai (usa o id do jogador como chave)
CREATE OR REPLACE FUNCTION public.leave_room(
  p_player_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player public.players;
  v_room public.rooms;
BEGIN
  IF p_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_player FROM public.players WHERE id = p_player_id LIMIT 1;
  IF v_player IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = v_player.room_id;

  -- No lobby (ou se a sala sumiu) podemos remover o registro;
  -- em qualquer fase ativa, só marcamos como desconectado p/ preservar histórico.
  IF v_room IS NULL OR v_room.status IN ('lobby','finished') THEN
    DELETE FROM public.players WHERE id = p_player_id;
  ELSE
    UPDATE public.players
       SET is_connected = false
     WHERE id = p_player_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.leave_room(text) TO anon, authenticated;

-- 3) Fecha DELETE direto em players (só via RPC agora).
DROP POLICY IF EXISTS "players public delete" ON public.players;


