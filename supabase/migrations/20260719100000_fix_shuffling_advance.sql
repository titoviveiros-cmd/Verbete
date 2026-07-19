-- ============================================================
-- CORREÇÃO CRÍTICA: sala travava em 'shuffling' com host ativo
--
-- O fluxo do client é writing -> start_shuffling() -> 'shuffling' ->
-- startVoting() -> advance_writing_to_voting. Mas a RPC só aceitava
-- status = 'writing', então com um host vivo a transição para votação
-- virava no-op e a sala ficava presa em 'shuffling' até o cleanup matar
-- a partida. (As rodadas sem nenhum client ativo funcionavam por
-- acaso: o cron chama extend_writing_or_advance ainda em 'writing' e
-- pula o shuffling.)
--
-- Fix: advance_writing_to_voting aceita 'writing' OU 'shuffling', e o
-- tick do cron passa a varrer salas presas em 'shuffling' também.
-- ============================================================

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
  IF v_room IS NULL OR v_room.status NOT IN ('writing', 'shuffling') THEN RETURN; END IF;
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

-- tick_stalled_rooms: varre 'shuffling' também (sala presa nessa fase
-- avança pra votação no próximo tick, sem esperar o cleanup de 30min).
CREATE OR REPLACE FUNCTION public.tick_stalled_rooms()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_count int := 0;
  v_clean jsonb;
BEGIN
  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'choosing'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_choosing_to_writing(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'writing'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.extend_writing_or_advance(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms WHERE status = 'shuffling'
  LOOP
    PERFORM public.advance_writing_to_voting(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'voting'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_voting_to_reveal(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT ro.id FROM public.rooms ro WHERE ro.status = 'reveal'
  LOOP
    PERFORM public.advance_reveal_to_scoreboard(r.id);
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'scoreboard'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_scoreboard_to_next_round_or_finished(r.id, false);
    v_count := v_count + 1;
  END LOOP;

  v_clean := public.cleanup_zombie_rooms();

  RETURN jsonb_build_object('advanced', v_count, 'cleanup', v_clean, 'at', now());
END;
$$;
