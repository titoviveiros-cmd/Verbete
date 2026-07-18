-- ============================================================
-- Chat de sala + salas públicas (especificação Verbete)
--
-- Chat (regras por fase, aplicadas server-side):
--   lobby ................. liberado
--   choosing/writing/
--   shuffling/voting ...... desativado (rodada em andamento)
--   reveal/scoreboard/
--   finished .............. liberado ("após resultado")
-- Rate-limit de 1 mensagem/800ms por jogador, mesmo padrão de send_reaction.
--
-- Salas públicas: rooms.visibility ('private' default). join_public_room
-- encontra um lobby público com vaga (FOR UPDATE SKIP LOCKED contra
-- corrida de dois jogadores entrando juntos) ou cria um novo, tornando o
-- chamador host. É o "🎲 Partida rápida" da home.
-- ============================================================

-- ---------- Chat ----------
CREATE TABLE IF NOT EXISTS public.room_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  player_id text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_room_messages_room_created
  ON public.room_messages(room_id, created_at DESC);

ALTER TABLE public.room_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "room_messages public read"
  ON public.room_messages FOR SELECT USING (true);
-- Sem policy de INSERT: escrita só pela RPC SECURITY DEFINER abaixo.

ALTER PUBLICATION supabase_realtime ADD TABLE public.room_messages;

CREATE OR REPLACE FUNCTION public.send_room_message(
  p_room_id uuid,
  p_player_id text,
  p_text text
) RETURNS jsonb
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
$function$;

GRANT EXECUTE ON FUNCTION public.send_room_message(uuid, text, text) TO anon, authenticated;

-- ---------- Salas públicas ----------
ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_visibility_check;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_visibility_check
  CHECK (visibility IN ('private', 'public'));

CREATE INDEX IF NOT EXISTS idx_rooms_public_lobby
  ON public.rooms(visibility, status, created_at) WHERE visibility = 'public' AND status = 'lobby';

CREATE OR REPLACE FUNCTION public.join_public_room(
  p_player_id text,
  p_nickname text,
  p_avatar text,
  p_color text
) RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_code text;
  v_attempts int := 0;
BEGIN
  -- Bloqueia banidos (mesma checagem do fluxo de entrar com código)
  IF public.is_player_banned(p_player_id, auth.uid()) THEN
    RAISE EXCEPTION 'player_banned';
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

  IF v_room IS NOT NULL THEN
    INSERT INTO public.players (id, room_id, nickname, avatar, color)
    VALUES (p_player_id, v_room.id, p_nickname, p_avatar, p_color)
    ON CONFLICT (id) DO UPDATE SET
      room_id = EXCLUDED.room_id,
      nickname = EXCLUDED.nickname,
      avatar = EXCLUDED.avatar,
      color = EXCLUDED.color,
      score = 0,
      coordinator_count = 0,
      writing_extensions = 0,
      voting_extensions = 0,
      kicked_at = NULL,
      is_connected = true;
    RETURN v_room;
  END IF;

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

  INSERT INTO public.players (id, room_id, nickname, avatar, color)
  VALUES (p_player_id, v_room.id, p_nickname, p_avatar, p_color)
  ON CONFLICT (id) DO UPDATE SET
    room_id = EXCLUDED.room_id,
    nickname = EXCLUDED.nickname,
    avatar = EXCLUDED.avatar,
    color = EXCLUDED.color,
    score = 0,
    coordinator_count = 0,
    writing_extensions = 0,
    voting_extensions = 0,
    kicked_at = NULL,
    is_connected = true;

  RETURN v_room;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.join_public_room(text, text, text, text) TO anon, authenticated;
