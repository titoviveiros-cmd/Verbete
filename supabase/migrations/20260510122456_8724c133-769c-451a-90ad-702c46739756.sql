-- 1) RPC: cria sala + insere o host em uma transação única
CREATE OR REPLACE FUNCTION public.create_room_with_host(
  p_host_id text,
  p_nickname text,
  p_avatar text,
  p_color text
)
RETURNS public.rooms
LANGUAGE plpgsql
SET search_path = public
AS $$
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
$$;

-- 2) RPC: estado completo da sala em uma chamada (room + players + defs + votes da rodada atual)
CREATE OR REPLACE FUNCTION public.get_room_state(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_room public.rooms;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'room', to_jsonb(v_room),
    'players', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.joined_at)
      FROM public.players p WHERE p.room_id = v_room.id
    ), '[]'::jsonb),
    'definitions', COALESCE((
      SELECT jsonb_agg(to_jsonb(d))
      FROM public.definitions d
      WHERE d.room_id = v_room.id AND d.round = v_room.current_round
    ), '[]'::jsonb),
    'votes', COALESCE((
      SELECT jsonb_agg(to_jsonb(v))
      FROM public.votes v
      WHERE v.room_id = v_room.id AND v.round = v_room.current_round
    ), '[]'::jsonb),
    'word', (
      SELECT to_jsonb(w) FROM public.words w WHERE w.id = v_room.current_word_id
    )
  );
END;
$$;

-- 3) Índices para acelerar consultas em tempo real
CREATE INDEX IF NOT EXISTS idx_players_room_id ON public.players(room_id);
CREATE INDEX IF NOT EXISTS idx_definitions_room_round ON public.definitions(room_id, round);
CREATE INDEX IF NOT EXISTS idx_votes_room_round ON public.votes(room_id, round);
CREATE INDEX IF NOT EXISTS idx_reactions_room_created ON public.reactions(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_code ON public.rooms(code);

-- Constraint única para evitar votos/defs duplicados em corridas
CREATE UNIQUE INDEX IF NOT EXISTS uniq_definitions_room_round_player
  ON public.definitions(room_id, round, player_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_votes_room_round_voter
  ON public.votes(room_id, round, voter_id);

