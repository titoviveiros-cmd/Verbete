-- =============================================================================
-- Identidade do jogador: um player_id pertence a UMA sala (playtest 2026-10-21).
--
-- Caso real: jogador recorrente tentou entrar numa sala nova e recebeu
--   duplicate key value violates unique constraint "players_pkey"
-- (em aba privada funcionou). players.id é PK GLOBAL e o cliente guarda o id
-- no aparelho; ninguém apaga a linha da partida anterior, então a próxima
-- entrada por código colide:
--   • rejoin_room procurava o id SÓ na sala atual e fazia INSERT puro → erro
--     bruto do banco na tela (e nem checava se o id era de outra pessoa);
--   • create_room_with_host / join_public_room faziam ON CONFLICT DO UPDATE
--     SET room_id → MOVIAM o jogador de sala em silêncio (a sala antiga
--     perdia a linha: histórico, bônus 🧠 tardio e pódio dela quebravam).
--
-- Regra nova, nas três portas de entrada de humano:
--   id inexistente                 → INSERT normal;
--   id na MESMA sala               → reentrada normal (rejoin_room);
--   id em OUTRA sala               → 'player_id_taken';
--   id de OUTRO usuário (qualquer) → 'player_id_taken'.
-- O cliente já trata 'player_id_taken': gera um id novo, persiste e tenta
-- UMA vez (createRoom/joinRoom). Corrida no INSERT (unique_violation) também
-- vira 'player_id_taken' — nenhum erro de chave do banco chega ao usuário.
-- Nunca se move jogador entre salas nem se troca room_id por UPSERT.
--
-- Compatível com o cliente em produção (mesmo contrato: as mesmas RPCs e o
-- mesmo motivo que ele já trata). Corpos = versões vigentes
-- (rejoin_room: 20261003110000; create_room_with_host e join_public_room:
-- 20261003100000) + a regra acima.
--
-- ROLLBACK: supabase/rollback/player_id_one_room.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rejoin_room(p_code text, p_player_id text, p_nickname text, p_avatar text, p_color text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_existing public.players;
  v_uid uuid := auth.uid();
  v_nick text := left(btrim(COALESCE(p_nickname, '')), 24);
BEGIN
  -- Mantém o endurecimento de 20261003100000 (sessão obrigatória).
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_player_id IS NULL OR char_length(p_player_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RAISE EXCEPTION 'room_not_found';
  END IF;

  -- O id em QUALQUER sala (antes: só nesta — o INSERT abaixo estourava a PK).
  SELECT * INTO v_existing FROM public.players WHERE id = p_player_id LIMIT 1;

  IF v_existing.id IS NOT NULL AND v_existing.user_id IS NOT NULL
     AND v_uid IS NOT NULL AND v_existing.user_id <> v_uid THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;
  -- Id já usado em OUTRA sala: o cliente troca de id (nunca movemos).
  IF v_existing.id IS NOT NULL AND v_existing.room_id IS DISTINCT FROM v_room.id THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.players
      SET kicked_at = NULL,
          is_connected = true,
          writing_extensions = 0,
          voting_extensions = 0,
          user_id = COALESCE(v_existing.user_id, v_uid),
          -- Só quem foi EXPULSO e voltou é tratado como entrada tardia
          -- (sala 7850: reload/retomada de aba renovava joined_at e o
          -- jogador era dispensado da rodada — voto ignorado). 'shuffling'
          -- faz parte da rodada em andamento (SM-01).
          joined_at = CASE
            WHEN v_existing.kicked_at IS NOT NULL
                 AND v_room.status IN ('writing','shuffling','voting') THEN now()
            ELSE v_existing.joined_at
          END,
          nickname = COALESCE(NULLIF(v_nick, ''), nickname),
          avatar = COALESCE(NULLIF(left(p_avatar, 16), ''), avatar),
          color = COALESCE(NULLIF(left(p_color, 32), ''), color)
      WHERE id = p_player_id;
  ELSE
    BEGIN
      INSERT INTO public.players (id, room_id, nickname, avatar, color, is_connected, user_id)
      VALUES (p_player_id, v_room.id, COALESCE(NULLIF(v_nick, ''), 'Anônimo'),
              left(p_avatar, 16), left(p_color, 32), true, v_uid);
    EXCEPTION WHEN unique_violation THEN
      -- Corrida (ex.: toque duplo): o mesmo id entrou agora por outra
      -- requisição. Nesta mesma sala e da mesma pessoa = já está dentro (sem
      -- trocar de id, que daria um lugar duplicado); senão, id de outro.
      IF NOT EXISTS (
        SELECT 1 FROM public.players
         WHERE id = p_player_id AND room_id = v_room.id
           AND (user_id IS NULL OR v_uid IS NULL OR user_id = v_uid)
      ) THEN
        RAISE EXCEPTION 'player_id_taken';
      END IF;
    END;
  END IF;

  RETURN to_jsonb(v_room);
END;
$function$;

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
