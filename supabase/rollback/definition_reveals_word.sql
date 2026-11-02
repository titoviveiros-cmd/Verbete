-- ROLLBACK de 20261102120000_definition_reveals_word.sql: submit_definition
-- volta ao corpo de 20261003100000 (sem as recusas) e as funções novas saem.
--   npx supabase db query --linked -f supabase/rollback/definition_reveals_word.sql
CREATE OR REPLACE FUNCTION public.submit_definition(p_room_id uuid, p_player_id text, p_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_clean text;
  v_norm text;
  v_id uuid;
  v_reason text;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL OR p_text IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  v_clean := substring(btrim(p_text) from 1 for 140);
  IF char_length(v_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_text');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  END IF;
  IF v_room.current_coordinator = p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'coordinator_cannot_write');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_player_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_player_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  v_norm := regexp_replace(lower(unaccent(v_clean)), '[^a-z0-9]+', ' ', 'g');

  -- Idêntica (normalizada)
  IF char_length(btrim(v_norm)) > 0 AND EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.player_id <> p_player_id
      AND regexp_replace(lower(unaccent(d.text)), '[^a-z0-9]+', ' ', 'g') = v_norm
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_definition');
  END IF;

  -- Muito parecida (playtest: IA/bots convergiam em textos quase iguais,
  -- ex.: "excesso de elegancia mundana" vs "excesso de elegancia formal")
  IF char_length(btrim(v_norm)) > 12 AND EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.player_id <> p_player_id
      AND similarity(
            regexp_replace(lower(unaccent(d.text)), '[^a-z0-9]+', ' ', 'g'),
            v_norm
          ) > 0.62
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_similar');
  END IF;

  INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
  VALUES (p_room_id, v_room.current_round, p_player_id, v_clean, false)
  ON CONFLICT (room_id, round, player_id)
    DO UPDATE SET text = EXCLUDED.text, created_at = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;

DROP FUNCTION IF EXISTS public.definition_reveals_word(text, text);
DROP FUNCTION IF EXISTS public.definition_reveal_tokens(text);
