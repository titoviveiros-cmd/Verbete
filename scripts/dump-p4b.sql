
-- ===== host_update_room_config =====
CREATE OR REPLACE FUNCTION public.host_update_room_config(p_room_id uuid, p_actor_id text, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_win_condition text;
  v_win_target int;
  v_mode text;
  v_nivel text;
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

  IF p_patch ? 'win_condition' THEN
    v_win_condition := p_patch->>'win_condition';
    IF v_win_condition NOT IN ('score','rounds') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_win_condition');
    END IF;
    UPDATE public.rooms SET win_condition = v_win_condition WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'win_target' THEN
    v_win_target := (p_patch->>'win_target')::int;
    IF v_win_target IS NULL OR v_win_target < 1 OR v_win_target > 5000 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_win_target');
    END IF;
    UPDATE public.rooms SET win_target = v_win_target WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'nivel' THEN
    v_nivel := p_patch->>'nivel';
    IF v_nivel NOT IN ('facil', 'medio', 'dificil', 'insano', 'aleatorio') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_nivel');
    END IF;
    UPDATE public.rooms SET nivel = v_nivel WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'categories' THEN
    SELECT array_agg(substring(btrim(value::text, '"') from 1 for 40))
      INTO v_categories
      FROM jsonb_array_elements_text(p_patch->'categories') AS t(value)
      WHERE char_length(btrim(value::text, '"')) BETWEEN 1 AND 40;
    UPDATE public.rooms SET categories = COALESCE(v_categories, '{}'::text[]) WHERE id = p_room_id;
  END IF;

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
$function$


-- ===== create_room_with_host =====
CREATE OR REPLACE FUNCTION public.create_room_with_host(p_host_id text, p_nickname text, p_avatar text, p_color text)
 RETURNS rooms
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_code text;
  v_room public.rooms;
  v_attempts int := 0;
BEGIN
  LOOP
    v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
    v_attempts := v_attempts + 1;
    IF v_attempts > 8 THEN
      RAISE EXCEPTION 'could not generate unique room code';
    END IF;
  END LOOP;

  INSERT INTO public.rooms (code, host_id, status)
  VALUES (v_code, p_host_id, 'lobby')
  RETURNING * INTO v_room;

  INSERT INTO public.players (id, room_id, nickname, avatar, color)
  VALUES (p_host_id, v_room.id, p_nickname, p_avatar, p_color)
  ON CONFLICT (id) DO UPDATE SET
    room_id = EXCLUDED.room_id,
    nickname = EXCLUDED.nickname,
    avatar = EXCLUDED.avatar,
    color = EXCLUDED.color,
    is_connected = true;

  RETURN v_room;
END;
$function$


-- ===== send_reaction =====
CREATE OR REPLACE FUNCTION public.send_reaction(p_room_id uuid, p_player_id text, p_emoji text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_last timestamptz;
  v_emoji text;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL OR p_emoji IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  -- Sanitiza emoji (limita a 8 chars para cobrir emojis compostos)
  v_emoji := substring(p_emoji from 1 for 8);
  IF char_length(v_emoji) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_emoji');
  END IF;

  -- Confirma que o jogador pertence à sala e não foi expulso
  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_player_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;

  -- Rate-limit: 1 reação a cada 800ms por jogador
  SELECT max(created_at) INTO v_last
    FROM public.reactions
    WHERE room_id = p_room_id AND player_id = p_player_id;

  IF v_last IS NOT NULL AND v_last > now() - interval '800 milliseconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cooldown');
  END IF;

  INSERT INTO public.reactions (room_id, player_id, emoji)
  VALUES (p_room_id, p_player_id, v_emoji);

  -- Limpa reactions antigas da sala (>30s) para evitar crescimento
  DELETE FROM public.reactions
    WHERE room_id = p_room_id AND created_at < now() - interval '30 seconds';

  RETURN jsonb_build_object('ok', true);
END;
$function$


-- ===== send_room_message =====
CREATE OR REPLACE FUNCTION public.send_room_message(p_room_id uuid, p_player_id text, p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_clean text;
  v_last timestamptz;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;

  -- Chat desativado durante a rodada (spec)
  IF v_room.status IN ('choosing', 'writing', 'shuffling', 'voting') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chat_disabled_in_round');
  END IF;

  -- Precisa ser jogador vivo da sala
  IF NOT EXISTS (
    SELECT 1 FROM public.players p
    WHERE p.id = p_player_id AND p.room_id = p_room_id AND p.kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;

  v_clean := substring(btrim(COALESCE(p_text, '')) from 1 for 200);
  IF char_length(v_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty');
  END IF;

  -- Rate-limit: 1 mensagem a cada 800ms por jogador
  SELECT max(created_at) INTO v_last FROM public.room_messages
  WHERE room_id = p_room_id AND player_id = p_player_id;
  IF v_last IS NOT NULL AND v_last > now() - interval '800 milliseconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  INSERT INTO public.room_messages (room_id, player_id, text)
  VALUES (p_room_id, p_player_id, v_clean);

  RETURN jsonb_build_object('ok', true);
END;
$function$

