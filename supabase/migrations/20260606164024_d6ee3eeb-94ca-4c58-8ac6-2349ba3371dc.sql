
-- 1. Adiciona contador de prorrogações de votação
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS voting_extensions integer NOT NULL DEFAULT 0;

-- 2. Corrige extend_writing_or_advance: exclui o coordenador da lista de pendentes
CREATE OR REPLACE FUNCTION public.extend_writing_or_advance(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_pending record;
  v_extended boolean := false;
  v_kicked text[] := ARRAY[]::text[];
  v_extended_players text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;

  FOR v_pending IN
    SELECT p.id, p.writing_extensions
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.is_connected = true
      AND p.id <> COALESCE(v_room.current_coordinator, '')
      AND NOT EXISTS (
        SELECT 1 FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      )
  LOOP
    IF v_pending.writing_extensions < 2 THEN
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            writing_extensions = writing_extensions + 1
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.writing_extensions + 1)
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
    ELSE
      UPDATE public.players SET score = GREATEST(score - 1, 0) WHERE id = v_pending.id;
      DELETE FROM public.players WHERE id = v_pending.id;
      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    UPDATE public.rooms
      SET round_phase_ends_at = now() + interval '20 seconds'
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'extended_players', to_jsonb(v_extended_players),
      'kicked', to_jsonb(v_kicked)
    );
  END IF;

  PERFORM public.advance_writing_to_voting(p_room_id);
  RETURN jsonb_build_object(
    'action', 'advanced',
    'kicked', to_jsonb(v_kicked)
  );
END;
$function$;

-- 3. Nova RPC: prorroga votação ou avança para reveal
CREATE OR REPLACE FUNCTION public.extend_voting_or_advance(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_pending record;
  v_extended boolean := false;
  v_kicked text[] := ARRAY[]::text[];
  v_extended_players text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;

  FOR v_pending IN
    SELECT p.id, p.voting_extensions
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.is_connected = true
      AND NOT EXISTS (
        SELECT 1 FROM public.votes v
        WHERE v.room_id = p_room_id
          AND v.round = v_room.current_round
          AND v.voter_id = p.id
      )
  LOOP
    IF v_pending.voting_extensions < 2 THEN
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            voting_extensions = voting_extensions + 1
        WHERE id = v_pending.id;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
    ELSE
      UPDATE public.players SET score = GREATEST(score - 1, 0) WHERE id = v_pending.id;
      DELETE FROM public.players WHERE id = v_pending.id;
      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    -- Prorrogação proporcionalmente menor: 15s (metade dos 30s da fase)
    UPDATE public.rooms
      SET round_phase_ends_at = now() + interval '15 seconds'
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'extended_players', to_jsonb(v_extended_players),
      'kicked', to_jsonb(v_kicked)
    );
  END IF;

  RETURN jsonb_build_object(
    'action', 'advance',
    'kicked', to_jsonb(v_kicked)
  );
END;
$function$;


