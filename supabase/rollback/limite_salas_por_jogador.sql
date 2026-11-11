-- Reversão da 20261111100000_limite_salas_por_jogador: create_room_with_host e
-- join_public_room voltam aos corpos da 20261111090000 (PR #60) byte a byte;
-- room_create_guard e room_create_log saem. Salas que já tiveram o código
-- liberado continuam com code 'arq-<id>' (encerradas pela limpeza; a retenção
-- de 30 dias as apaga como antes) — não há o que desfazer nelas.
-- Depois: supabase migration repair --status reverted 20261111100000
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

  -- Código de 4 dígitos (1000–9999), único em rooms (rooms_code_key).
  -- Antes: 9 sorteios e "checa, depois insere" — (1) duas criações
  -- simultâneas com o mesmo sorteio davam unique_violation crua ao
  -- cliente; (2) com a tabela cheia (salas encerradas ficam 30 dias)
  -- os 9 sorteios esgotavam com códigos livres sobrando. Agora: até 12
  -- sorteios, depois sorteio ENTRE OS LIVRES; colisão no INSERT (corrida)
  -- tenta de novo. Erro só com os 9.000 códigos ocupados (ou 40 voltas).
  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > 40 THEN
      RAISE EXCEPTION 'could not generate unique room code';
    END IF;
    IF v_attempts <= 12 THEN
      v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
    ELSE
      v_code := NULL;
      SELECT c::text INTO v_code
        FROM generate_series(1000, 9999) AS c
       WHERE NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.code = c::text)
       ORDER BY random()
       LIMIT 1;
      IF v_code IS NULL THEN
        RAISE EXCEPTION 'could not generate unique room code';
      END IF;
    END IF;
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
    BEGIN
      INSERT INTO public.rooms (code, host_id, status)
      VALUES (v_code, p_host_id, 'lobby')
      RETURNING * INTO v_room;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- Só a corrida do código é absorvida; outra violação sobe.
      IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code) THEN
        RAISE;
      END IF;
    END;
  END LOOP;

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
    -- Código de 4 dígitos (1000–9999), único em rooms (rooms_code_key).
    -- Antes: 9 sorteios e "checa, depois insere" — (1) duas criações
    -- simultâneas com o mesmo sorteio davam unique_violation crua ao
    -- cliente; (2) com a tabela cheia (salas encerradas ficam 30 dias)
    -- os 9 sorteios esgotavam com códigos livres sobrando. Agora: até 12
    -- sorteios, depois sorteio ENTRE OS LIVRES; colisão no INSERT (corrida)
    -- tenta de novo. Erro só com os 9.000 códigos ocupados (ou 40 voltas).
    LOOP
      v_attempts := v_attempts + 1;
      IF v_attempts > 40 THEN
        RAISE EXCEPTION 'could not generate unique room code';
      END IF;
      IF v_attempts <= 12 THEN
        v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
      ELSE
        v_code := NULL;
        SELECT c::text INTO v_code
          FROM generate_series(1000, 9999) AS c
         WHERE NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.code = c::text)
         ORDER BY random()
         LIMIT 1;
        IF v_code IS NULL THEN
          RAISE EXCEPTION 'could not generate unique room code';
        END IF;
      END IF;
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
      BEGIN
        INSERT INTO public.rooms (code, host_id, status, visibility)
        VALUES (v_code, p_player_id, 'lobby', 'public')
        RETURNING * INTO v_room;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- Só a corrida do código é absorvida; outra violação sobe.
        IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code) THEN
          RAISE;
        END IF;
      END;
    END LOOP;
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

DROP FUNCTION IF EXISTS public.room_create_guard(uuid);
DROP TABLE IF EXISTS public.room_create_log;
