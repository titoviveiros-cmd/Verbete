
-- ===== start_game =====
CREATE OR REPLACE FUNCTION public.start_game(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_min_count int;
  v_next_coordinator text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'lobby' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;

  UPDATE public.players
  SET score = 0, coordinator_count = 0, writing_extensions = 0, voting_extensions = 0
  WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  DELETE FROM public.round_extensions WHERE room_id = p_room_id;

  SELECT min(coordinator_count) INTO v_min_count
  FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL;
  SELECT id INTO v_next_coordinator FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count = v_min_count
  ORDER BY random() LIMIT 1;

  UPDATE public.rooms
  SET status = 'choosing',
      current_round = 1,
      current_coordinator = v_next_coordinator,
      current_word_id = NULL,
      round_phase_ends_at = now() + interval '60 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'coordinator', v_next_coordinator);
END;
$function$


-- ===== reset_room =====
CREATE OR REPLACE FUNCTION public.reset_room(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.players
    SET score = 0, coordinator_count = 0,
        writing_extensions = 0, voting_extensions = 0
    WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  DELETE FROM public.round_extensions WHERE room_id = p_room_id;
  UPDATE public.rooms SET
    status = 'lobby',
    current_round = 0,
    current_coordinator = NULL,
    current_word_id = NULL,
    round_phase_ends_at = NULL
  WHERE id = p_room_id;
END;
$function$


-- ===== kick_player =====
CREATE OR REPLACE FUNCTION public.kick_player(p_room_id uuid, p_actor_id text, p_target_player_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$


-- ===== assign_player_team =====
CREATE OR REPLACE FUNCTION public.assign_player_team(p_room_id uuid, p_actor_id text, p_player_id text, p_team_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$


-- ===== rejoin_room =====
CREATE OR REPLACE FUNCTION public.rejoin_room(p_code text, p_player_id text, p_nickname text, p_avatar text, p_color text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_existing public.players;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RAISE EXCEPTION 'room_not_found';
  END IF;

  SELECT * INTO v_existing FROM public.players WHERE id = p_player_id AND room_id = v_room.id LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.players
      SET kicked_at = NULL,
          is_connected = true,
          writing_extensions = 0,
          voting_extensions = 0,
          -- Se a sala está em fase ativa, "renova" o joined_at para que o
          -- jogador seja tratado como entrada tardia e não leve penalidade
          -- na rodada que já estava em andamento.
          joined_at = CASE
            WHEN v_room.status IN ('writing','voting') THEN now()
            ELSE v_existing.joined_at
          END,
          nickname = COALESCE(NULLIF(p_nickname, ''), nickname),
          avatar = COALESCE(NULLIF(p_avatar, ''), avatar),
          color = COALESCE(NULLIF(p_color, ''), color)
      WHERE id = p_player_id;
  ELSE
    INSERT INTO public.players (id, room_id, nickname, avatar, color, is_connected)
    VALUES (p_player_id, v_room.id, p_nickname, p_avatar, p_color, true);
  END IF;

  RETURN to_jsonb(v_room);
END;
$function$


-- ===== claim_player_identity =====
CREATE OR REPLACE FUNCTION public.claim_player_identity(p_player_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  UPDATE public.players
  SET user_id = auth.uid()
  WHERE id = p_player_id
    AND (user_id IS NULL OR user_id = auth.uid());
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_owned_by_other_user');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$

