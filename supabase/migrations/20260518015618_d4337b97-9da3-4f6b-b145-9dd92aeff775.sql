CREATE OR REPLACE FUNCTION public.advance_voting_to_reveal(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_truth_def_id uuid;
  v_truth_voters int;
  v_total_votes int;
  v_defs_count int;
  v_inserted boolean := false;
  r record;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' THEN RETURN; END IF;

  -- Guard: don't score with zero votes unless the round is REALLY stalled.
  -- Bots vote client-side with a 2-5s setTimeout, and the realtime sync to
  -- the host may lag; advancing too eagerly creates rounds with 0 score.
  SELECT count(*) INTO v_total_votes FROM public.votes
  WHERE room_id = p_room_id AND round = v_room.current_round;
  SELECT count(*) INTO v_defs_count FROM public.definitions
  WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = false AND player_id <> '__truth__';

  IF v_total_votes = 0 AND v_defs_count > 0 AND (
       v_room.round_phase_ends_at IS NULL
       OR v_room.round_phase_ends_at > now() - interval '90 seconds'
     ) THEN
    -- Wait — bots/humans may still be voting. Don't insert rounds row yet.
    RETURN;
  END IF;

  -- Idempotência: tenta inserir em rounds (UNIQUE room_id+round assumido)
  BEGIN
    INSERT INTO public.rounds (room_id, round, coordinator_id, word_id)
    VALUES (p_room_id, v_room.current_round, v_room.current_coordinator, v_room.current_word_id);
    v_inserted := true;
  EXCEPTION WHEN unique_violation THEN
    v_inserted := false;
  END;

  IF NOT v_inserted THEN
    UPDATE public.rooms SET status = 'reveal' WHERE id = p_room_id;
    RETURN;
  END IF;

  SELECT id INTO v_truth_def_id FROM public.definitions
  WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = true;

  -- +2 para quem votou na verdade
  SELECT count(*) INTO v_truth_voters FROM public.votes
  WHERE room_id = p_room_id AND round = v_room.current_round AND definition_id = v_truth_def_id;

  IF v_truth_def_id IS NOT NULL THEN
    UPDATE public.players p SET score = p.score + 2
    WHERE p.id IN (
      SELECT voter_id FROM public.votes
      WHERE room_id = p_room_id AND round = v_room.current_round AND definition_id = v_truth_def_id
    );
  END IF;

  -- +1 para o autor por cada voto recebido em definição falsa
  FOR r IN
    SELECT d.player_id, count(v.id) AS votes
    FROM public.definitions d
    LEFT JOIN public.votes v ON v.definition_id = d.id
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.is_truth = false AND d.player_id <> '__truth__'
    GROUP BY d.player_id
    HAVING count(v.id) > 0
  LOOP
    UPDATE public.players SET score = score + r.votes WHERE id = r.player_id;
  END LOOP;

  -- +2 para coordenador se ninguém votou na verdade (apenas se houve votos)
  IF v_truth_voters = 0 AND v_total_votes > 0 AND v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET score = score + 2 WHERE id = v_room.current_coordinator;
  END IF;

  -- coordinator_count++
  IF v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET coordinator_count = coordinator_count + 1
    WHERE id = v_room.current_coordinator;
  END IF;

  UPDATE public.rooms SET status = 'reveal' WHERE id = p_room_id;
END;
$function$;

