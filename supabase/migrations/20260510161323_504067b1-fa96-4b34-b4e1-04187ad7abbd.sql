CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

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

  SELECT * INTO v_word FROM public.words WHERE id = v_room.current_word_id;
  IF v_word IS NULL THEN RETURN; END IF;

  v_truth := lower(extensions.unaccent(v_word.meaning));
  v_truth := regexp_replace(v_truth, '^(\(?[a-z]{1,5}\.(\s*[a-z]{1,5}\.)?\)?|\([^)]{1,30}\))[\s:;,-]+', '', 'g');
  v_truth := regexp_replace(v_truth, '^(\(?[a-z]{1,5}\.(\s*[a-z]{1,5}\.)?\)?|\([^)]{1,30}\))[\s:;,-]+', '', 'g');
  v_truth := split_part(v_truth, ';', 1);
  v_truth := btrim(v_truth);
  IF char_length(v_truth) > 90 THEN
    v_truth := substring(v_truth from 1 for 90);
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
      round_phase_ends_at = now() + interval '30 seconds'
  WHERE id = p_room_id;
END;
$function$;

