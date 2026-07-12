-- Penalidade: -1 ponto APENAS por prorrogação recebida (não no kick final).

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
  v_extension_seconds int := 0;
  v_kicked text[] := ARRAY[]::text[];
  v_extended_players text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;

  IF v_room.round_phase_ends_at IS NOT NULL
     AND v_room.round_phase_ends_at > now() - interval '2 seconds' THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  UPDATE public.players p
    SET writing_extensions = 0
    WHERE p.room_id = p_room_id
      AND p.kicked_at IS NULL
      AND p.is_bot = false
      AND p.writing_extensions > 0
      AND EXISTS (
        SELECT 1 FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      );

  FOR v_pending IN
    SELECT p.id, p.writing_extensions
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.kicked_at IS NULL
      AND p.id <> COALESCE(v_room.current_coordinator, '')
      AND (v_room.phase_started_at IS NULL
           OR p.joined_at <= v_room.phase_started_at + interval '3 seconds')
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
            writing_extensions = writing_extensions + 1,
            is_connected = true
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.writing_extensions + 1)
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
      v_extension_seconds := GREATEST(
        v_extension_seconds,
        CASE WHEN v_pending.writing_extensions = 0 THEN 20 ELSE 10 END
      );
    ELSE
      -- Kick não é uma prorrogação — não deduz ponto adicional.
      UPDATE public.players
        SET kicked_at = now(),
            is_connected = false
        WHERE id = v_pending.id;
      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    UPDATE public.rooms
      SET round_phase_ends_at = now() + make_interval(secs => v_extension_seconds),
          phase_started_at = now()
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'seconds', v_extension_seconds,
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

CREATE OR REPLACE FUNCTION public.guard_writing_phase_advance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pending record;
  v_has_pending boolean := false;
  v_extended boolean := false;
  v_extension_seconds int := 0;
  v_now timestamptz := now();
BEGIN
  IF OLD.status = 'writing'
     AND NEW.status IN ('shuffling', 'voting')
     AND NEW.current_round = OLD.current_round THEN

    FOR v_pending IN
      SELECT p.id, p.writing_extensions
      FROM public.players p
      WHERE p.room_id = OLD.id
        AND p.is_bot = false
        AND p.kicked_at IS NULL
        AND p.id <> COALESCE(OLD.current_coordinator, '')
        AND (OLD.phase_started_at IS NULL OR p.joined_at <= OLD.phase_started_at + interval '3 seconds')
        AND NOT EXISTS (
          SELECT 1 FROM public.definitions d
          WHERE d.room_id = OLD.id
            AND d.round = OLD.current_round
            AND d.player_id = p.id
        )
    LOOP
      v_has_pending := true;

      IF OLD.round_phase_ends_at IS NOT NULL
         AND OLD.round_phase_ends_at <= v_now THEN
        IF v_pending.writing_extensions < 2 THEN
          UPDATE public.players
          SET score = GREATEST(score - 1, 0),
              writing_extensions = writing_extensions + 1,
              is_connected = true
          WHERE id = v_pending.id;

          INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
          VALUES (OLD.id, OLD.current_round, v_pending.id, v_pending.writing_extensions + 1)
          ON CONFLICT DO NOTHING;

          v_extended := true;
          v_extension_seconds := GREATEST(
            v_extension_seconds,
            CASE WHEN v_pending.writing_extensions = 0 THEN 20 ELSE 10 END
          );
        ELSE
          -- Kick não é uma prorrogação — não deduz ponto adicional.
          UPDATE public.players
          SET kicked_at = v_now,
              is_connected = false
          WHERE id = v_pending.id;
        END IF;
      END IF;
    END LOOP;

    IF v_has_pending THEN
      NEW.status := 'writing';
      NEW.current_round := OLD.current_round;
      NEW.current_word_id := OLD.current_word_id;
      NEW.current_coordinator := OLD.current_coordinator;
      NEW.used_word_ids := OLD.used_word_ids;
      NEW.phase_started_at := CASE WHEN v_extended THEN v_now ELSE OLD.phase_started_at END;
      NEW.round_phase_ends_at := CASE WHEN v_extended THEN v_now + make_interval(secs => v_extension_seconds) ELSE OLD.round_phase_ends_at END;
      RETURN NEW;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

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

  IF v_room.round_phase_ends_at IS NOT NULL
     AND v_room.round_phase_ends_at > now() - interval '2 seconds' THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  UPDATE public.players p
    SET voting_extensions = 0
    WHERE p.room_id = p_room_id
      AND p.kicked_at IS NULL
      AND p.is_bot = false
      AND p.voting_extensions > 0
      AND EXISTS (
        SELECT 1 FROM public.votes v
        WHERE v.room_id = p_room_id
          AND v.round = v_room.current_round
          AND v.voter_id = p.id
      );

  FOR v_pending IN
    SELECT p.id, p.voting_extensions
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.kicked_at IS NULL
      AND (v_room.phase_started_at IS NULL
           OR p.joined_at <= v_room.phase_started_at + interval '3 seconds')
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
            voting_extensions = voting_extensions + 1,
            is_connected = true
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.voting_extensions + 1)
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
    ELSE
      -- Kick não é uma prorrogação — não deduz ponto adicional.
      UPDATE public.players
        SET kicked_at = now(),
            is_connected = false
        WHERE id = v_pending.id;
      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    UPDATE public.rooms
      SET round_phase_ends_at = now() + interval '15 seconds',
          phase_started_at = now()
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'extended_players', to_jsonb(v_extended_players),
      'kicked', to_jsonb(v_kicked)
    );
  END IF;

  PERFORM public.advance_voting_to_reveal(p_room_id);
  RETURN jsonb_build_object(
    'action', 'advanced',
    'kicked', to_jsonb(v_kicked)
  );
END;
$function$;

