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
          SELECT 1
          FROM public.definitions d
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
        ELSE
          UPDATE public.players
          SET score = GREATEST(score - 1, 0),
              kicked_at = v_now,
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
      NEW.round_phase_ends_at := CASE WHEN v_extended THEN v_now + interval '20 seconds' ELSE OLD.round_phase_ends_at END;
      RETURN NEW;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_writing_phase_advance_trigger ON public.rooms;
CREATE TRIGGER guard_writing_phase_advance_trigger
BEFORE UPDATE OF status ON public.rooms
FOR EACH ROW
EXECUTE FUNCTION public.guard_writing_phase_advance();

CREATE OR REPLACE FUNCTION public.advance_writing_to_voting(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_word public.words;
  v_def_ids uuid[];
  v_letters text := 'ABCDEFGHIJKLM';
  v_id uuid;
  v_idx int := 1;
  v_truth text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'writing' THEN RETURN; END IF;
  IF v_room.current_word_id IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.kicked_at IS NULL
      AND p.id <> COALESCE(v_room.current_coordinator, '')
      AND (v_room.phase_started_at IS NULL OR p.joined_at <= v_room.phase_started_at + interval '3 seconds')
      AND NOT EXISTS (
        SELECT 1
        FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      )
  ) THEN
    RETURN;
  END IF;

  SELECT * INTO v_word FROM public.words WHERE id = v_room.current_word_id;
  IF v_word IS NULL THEN RETURN; END IF;

  v_truth := lower(extensions.unaccent(v_word.meaning));
  v_truth := regexp_replace(v_truth, '^(\(?[a-z]{1,5}\.(\s*[a-z]{1,5}\.)?\)?|\([^)]{1,30}\))[\s:;,-]+', '', 'g');
  v_truth := regexp_replace(v_truth, '^(\(?[a-z]{1,5}\.(\s*[a-z]{1,5}\.)?\)?|\([^)]{1,30}\))[\s:;,-]+', '', 'g');
  v_truth := split_part(v_truth, ';', 1);
  v_truth := btrim(v_truth);
  IF char_length(v_truth) > 60 THEN
    v_truth := substring(v_truth from 1 for 60);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.definitions
    WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = true
  ) THEN
    INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
    VALUES (p_room_id, v_room.current_round, '__truth__', v_truth, true);
  END IF;

  SELECT array_agg(id ORDER BY random()) INTO v_def_ids
  FROM public.definitions
  WHERE room_id = p_room_id AND round = v_room.current_round;

  FOREACH v_id IN ARRAY v_def_ids LOOP
    UPDATE public.definitions SET letter = substr(v_letters, v_idx, 1) WHERE id = v_id;
    v_idx := v_idx + 1;
  END LOOP;

  UPDATE public.rooms
  SET status = 'voting',
      round_phase_ends_at = now() + interval '30 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;
END;
$function$;

