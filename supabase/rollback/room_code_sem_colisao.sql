-- Reversão da 20261111090000_room_code_sem_colisao: devolve create_room_with_host
-- e join_public_room EXATAMENTE como na 20261021170000_player_id_one_room
-- (corpo byte a byte; permissões não mudam com CREATE OR REPLACE).
-- Depois: supabase migration repair --status reverted 20261111090000

CREATE OR REPLACE FUNCTION public.create_room_with_host(p_host_id text, p_nickname text, p_avatar text, p_color text)
RETURNS rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_code text;
  v_room public.rooms;
  v_attempts int := 0;
  v_uid uuid := auth.uid();
  v_nick text := left(btrim(COALESCE(p_nickname, '')), 24);
BEGIN
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_host_id IS NULL OR char_length(p_host_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;
  IF v_nick = '' THEN v_nick := 'Anônimo'; END IF;

  -- Sala nova = id novo: id que já existe (de outra pessoa ou de uma partida
  -- anterior) volta 'player_id_taken' e o cliente gera outro. Antes, o
  -- ON CONFLICT movia o jogador da sala antiga em silêncio.
  IF EXISTS (SELECT 1 FROM public.players WHERE id = p_host_id) THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

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

  BEGIN
    INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id)
    VALUES (p_host_id, v_room.id, v_nick, left(p_avatar, 16), left(p_color, 32), v_uid);
  EXCEPTION WHEN unique_violation THEN
    -- Corrida com outra entrada do mesmo id: desfaz a sala criada (a
    -- exceção reverte a transação inteira) e o cliente troca de id.
    RAISE EXCEPTION 'player_id_taken';
  END;

  RETURN v_room;
END;
$function$;

CREATE OR REPLACE FUNCTION public.join_public_room(p_player_id text, p_nickname text, p_avatar text, p_color text)
RETURNS rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_code text;
  v_attempts int := 0;
  v_uid uuid := auth.uid();
  v_nick text := left(btrim(COALESCE(p_nickname, '')), 24);
BEGIN
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_player_id IS NULL OR char_length(p_player_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;
  IF v_nick = '' THEN v_nick := 'Anônimo'; END IF;

  -- Bloqueia banidos ANTES de qualquer outra resposta (mesma checagem do
  -- fluxo de entrar com código) — trocar de id não escapa do banimento.
  IF public.is_player_banned(p_player_id, v_uid) THEN
    RAISE EXCEPTION 'player_banned';
  END IF;

  -- Mesma regra da criação: id existente (outra pessoa ou outra sala) não
  -- entra — antes o ON CONFLICT movia o jogador de sala.
  IF EXISTS (SELECT 1 FROM public.players WHERE id = p_player_id) THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  -- Procura lobby público com vaga; SKIP LOCKED evita que dois jogadores
  -- em corrida travem um no outro (cada um pega um lobby diferente ou cria).
  SELECT r.* INTO v_room
  FROM public.rooms r
  WHERE r.visibility = 'public'
    AND r.status = 'lobby'
    AND (SELECT count(*) FROM public.players p WHERE p.room_id = r.id AND p.kicked_at IS NULL) < 12
  ORDER BY r.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_room IS NULL THEN
    -- Nenhum lobby aberto: cria sala pública nova com o chamador como host
    LOOP
      v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
      v_attempts := v_attempts + 1;
      IF v_attempts > 8 THEN
        RAISE EXCEPTION 'could not generate unique room code';
      END IF;
    END LOOP;

    INSERT INTO public.rooms (code, host_id, status, visibility)
    VALUES (v_code, p_player_id, 'lobby', 'public')
    RETURNING * INTO v_room;
  END IF;

  BEGIN
    INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id)
    VALUES (p_player_id, v_room.id, v_nick, left(p_avatar, 16), left(p_color, 32), v_uid);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'player_id_taken';
  END;

  RETURN v_room;
END;
$function$;
