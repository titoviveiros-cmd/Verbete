CREATE OR REPLACE FUNCTION public.cleanup_zombie_rooms()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_finished int := 0;
  v_unstuck int := 0;
BEGIN
  -- 1) Salas paradas há > 30min em qualquer fase ativa: marca como finished
  --    (usa max entre created_at e round_phase_ends_at como "última atividade")
  WITH stale AS (
    UPDATE public.rooms
    SET status = 'finished'
    WHERE status IN ('lobby','shuffling','choosing','writing','voting','reveal','scoreboard')
      AND GREATEST(created_at, COALESCE(round_phase_ends_at, created_at)) < now() - interval '30 minutes'
    RETURNING 1
  )
  SELECT count(*) INTO v_finished FROM stale;

  -- 2) Salas presas em shuffling/choosing > 2min sem humanos conectados: finaliza
  WITH no_humans AS (
    UPDATE public.rooms r
    SET status = 'finished'
    WHERE r.status IN ('shuffling','choosing')
      AND r.created_at < now() - interval '2 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.players p
        WHERE p.room_id = r.id AND p.is_bot = false AND p.is_connected = true
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_unstuck FROM no_humans;

  RETURN jsonb_build_object('finished_stale', v_finished, 'finished_empty', v_unstuck, 'at', now());
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_zombie_rooms() FROM anon, authenticated, public;

-- Estende o tick para chamar cleanup também
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
    WHERE status = 'writing'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.extend_writing_or_advance(r.id);
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

  -- Limpeza de zumbis a cada tick (idempotente, barato)
  v_clean := public.cleanup_zombie_rooms();

  RETURN jsonb_build_object('advanced', v_count, 'cleanup', v_clean, 'at', now());
END;
$$;

-- Backfill imediato
SELECT public.cleanup_zombie_rooms();

