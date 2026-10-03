-- Desfaz a manutenção cleanup_zombie_rooms v2 (gerado por scripts/gen-m1-rollback.mjs)
-- Restaura a regra antiga (20260518210523_d6b119ea-3b30-43a5-916e-422329f6eed3.sql). As salas que a v2 encerrou eram
-- resíduos parados; se precisar, reverter o status com o snapshot do dry-run.
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

REVOKE ALL ON FUNCTION public.cleanup_zombie_rooms() FROM PUBLIC, anon, authenticated;
