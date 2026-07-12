
-- Habilita extensões necessárias
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Avança escrita → votação (insere verdade, atribui letras)
CREATE OR REPLACE FUNCTION public.advance_writing_to_voting(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room public.rooms;
  v_word public.words;
  v_def_ids uuid[];
  v_letters text := 'ABCDEFGHIJKLM';
  v_id uuid;
  v_idx int := 1;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'writing' THEN RETURN; END IF;
  IF v_room.current_word_id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_word FROM public.words WHERE id = v_room.current_word_id;
  IF v_word IS NULL THEN RETURN; END IF;

  -- Insere a verdade se ainda não existir
  IF NOT EXISTS (
    SELECT 1 FROM public.definitions
    WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = true
  ) THEN
    INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
    VALUES (p_room_id, v_room.current_round, '__truth__', v_word.meaning, true);
  END IF;

  -- Embaralha definições e atribui letras
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
$$;

-- Avança votação → revelação (calcula pontos)
CREATE OR REPLACE FUNCTION public.advance_voting_to_reveal(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room public.rooms;
  v_truth_def_id uuid;
  v_truth_voters int;
  v_inserted boolean := false;
  r record;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' THEN RETURN; END IF;

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

  -- +2 para coordenador se ninguém votou na verdade
  IF v_truth_voters = 0 AND v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET score = score + 2 WHERE id = v_room.current_coordinator;
  END IF;

  -- coordinator_count++
  IF v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET coordinator_count = coordinator_count + 1
    WHERE id = v_room.current_coordinator;
  END IF;

  UPDATE public.rooms SET status = 'reveal' WHERE id = p_room_id;
END;
$$;

-- Avança reveal → scoreboard depois de ~10s (reveal não tem ends_at, usa scored_at do rounds)
CREATE OR REPLACE FUNCTION public.advance_reveal_to_scoreboard(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room public.rooms;
  v_scored_at timestamptz;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'reveal' THEN RETURN; END IF;
  SELECT scored_at INTO v_scored_at FROM public.rounds
  WHERE room_id = p_room_id AND round = v_room.current_round LIMIT 1;
  IF v_scored_at IS NULL OR v_scored_at > now() - interval '10 seconds' THEN RETURN; END IF;
  UPDATE public.rooms SET status = 'scoreboard' WHERE id = p_room_id;
END;
$$;

-- Watchdog principal: avança todas as salas que passaram do tempo
CREATE OR REPLACE FUNCTION public.tick_stalled_rooms()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_count int := 0;
BEGIN
  -- writing expirado
  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'writing'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_writing_to_voting(r.id);
    v_count := v_count + 1;
  END LOOP;

  -- voting expirado
  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'voting'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_voting_to_reveal(r.id);
    v_count := v_count + 1;
  END LOOP;

  -- reveal antigo
  FOR r IN
    SELECT ro.id FROM public.rooms ro
    WHERE ro.status = 'reveal'
  LOOP
    PERFORM public.advance_reveal_to_scoreboard(r.id);
  END LOOP;

  RETURN jsonb_build_object('advanced', v_count, 'at', now());
END;
$$;

-- Constraint UNIQUE em rounds para idempotência (se já não existir)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rounds_room_round_unique'
  ) THEN
    BEGIN
      ALTER TABLE public.rounds ADD CONSTRAINT rounds_room_round_unique UNIQUE (room_id, round);
    EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
    END;
  END IF;
END$$;

-- Agendar tick a cada minuto via pg_cron
SELECT cron.unschedule('verbete-tick-stalled-rooms')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-tick-stalled-rooms');

SELECT cron.schedule(
  'verbete-tick-stalled-rooms',
  '* * * * *',
  $cron$ SELECT public.tick_stalled_rooms(); $cron$
);


