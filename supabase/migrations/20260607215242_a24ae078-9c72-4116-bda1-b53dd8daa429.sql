-- Fase 1 da auditoria: rate-limit servidor-side para reactions
CREATE OR REPLACE FUNCTION public.send_reaction(
  p_room_id uuid,
  p_player_id text,
  p_emoji text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.send_reaction(uuid, text, text) TO anon, authenticated;


