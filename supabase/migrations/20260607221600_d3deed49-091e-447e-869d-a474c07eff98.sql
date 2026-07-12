-- host_update_room_config: só host, só no lobby, só campos permitidos.
CREATE OR REPLACE FUNCTION public.host_update_room_config(
  p_room_id uuid,
  p_actor_id text,
  p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room public.rooms;
  v_win_condition text;
  v_win_target int;
  v_mode text;
  v_categories text[];
  v_teams jsonb;
BEGIN
  IF p_room_id IS NULL OR p_actor_id IS NULL OR p_patch IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.host_id <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_host');
  END IF;
  IF v_room.status <> 'lobby' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_lobby');
  END IF;

  -- win_condition / win_target
  IF p_patch ? 'win_condition' THEN
    v_win_condition := p_patch->>'win_condition';
    IF v_win_condition NOT IN ('score','rounds') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_win_condition');
    END IF;
    UPDATE public.rooms SET win_condition = v_win_condition WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'win_target' THEN
    v_win_target := (p_patch->>'win_target')::int;
    IF v_win_target IS NULL OR v_win_target < 1 OR v_win_target > 200 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_win_target');
    END IF;
    UPDATE public.rooms SET win_target = v_win_target WHERE id = p_room_id;
  END IF;

  -- categories (array de strings curtas)
  IF p_patch ? 'categories' THEN
    SELECT array_agg(substring(btrim(value::text, '"') from 1 for 40))
      INTO v_categories
      FROM jsonb_array_elements_text(p_patch->'categories') AS t(value)
      WHERE char_length(btrim(value::text, '"')) BETWEEN 1 AND 40;
    UPDATE public.rooms SET categories = COALESCE(v_categories, '{}'::text[]) WHERE id = p_room_id;
  END IF;

  -- mode + teams (são definidos juntos por setRoomMode/setRoomTeams)
  IF p_patch ? 'mode' THEN
    v_mode := p_patch->>'mode';
    IF v_mode NOT IN ('individual','teams') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_mode');
    END IF;
    UPDATE public.rooms SET mode = v_mode WHERE id = p_room_id;
    IF v_mode = 'individual' THEN
      UPDATE public.players SET team_id = NULL WHERE room_id = p_room_id;
    END IF;
  END IF;

  IF p_patch ? 'teams' THEN
    v_teams := p_patch->'teams';
    IF jsonb_typeof(v_teams) <> 'array' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_teams');
    END IF;
    IF jsonb_array_length(v_teams) > 8 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'too_many_teams');
    END IF;
    UPDATE public.rooms SET teams = v_teams WHERE id = p_room_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.host_update_room_config(uuid, text, jsonb) TO anon, authenticated;

-- assign_player_team: só host, só no lobby
CREATE OR REPLACE FUNCTION public.assign_player_team(
  p_room_id uuid,
  p_actor_id text,
  p_player_id text,
  p_team_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room public.rooms;
BEGIN
  IF p_room_id IS NULL OR p_actor_id IS NULL OR p_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.host_id <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_host');
  END IF;
  IF v_room.status <> 'lobby' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_lobby');
  END IF;

  UPDATE public.players
     SET team_id = NULLIF(p_team_id, '')
   WHERE id = p_player_id AND room_id = p_room_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_player_team(uuid, text, text, text) TO anon, authenticated;


