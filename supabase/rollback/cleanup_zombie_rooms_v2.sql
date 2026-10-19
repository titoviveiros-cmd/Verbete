-- ROLLBACK da R4 (migration 20261019002735): volta o cleanup_zombie_rooms
-- para a v2 (migration 20261018234149, corpo de
-- supabase/maintenance/20261003_cleanup_zombie_rooms_v2.sql) e remove a
-- função auxiliar da R4. As salas que a R4 encerrou continuam encerradas
-- (eram salas sem ação humana há 30+ min).

CREATE OR REPLACE FUNCTION public.cleanup_zombie_rooms()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_finished int := 0;
  v_lobby int := 0;
  v_unstuck int := 0;
BEGIN
  WITH stale AS (
    UPDATE public.rooms
    SET status = 'finished', round_phase_ends_at = NULL
    WHERE status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
      AND COALESCE(phase_started_at, created_at) < now() - interval '30 minutes'
    RETURNING 1
  )
  SELECT count(*) INTO v_finished FROM stale;

  WITH stale_lobby AS (
    UPDATE public.rooms r
    SET status = 'finished'
    WHERE r.status = 'lobby'
      AND GREATEST(
            r.created_at,
            COALESCE((SELECT max(p.joined_at) FROM public.players p WHERE p.room_id = r.id), r.created_at),
            COALESCE((SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id), r.created_at)
          ) < now() - interval '60 minutes'
    RETURNING 1
  )
  SELECT count(*) INTO v_lobby FROM stale_lobby;

  WITH no_humans AS (
    UPDATE public.rooms r
    SET status = 'finished'
    WHERE r.status IN ('shuffling', 'choosing')
      AND r.created_at < now() - interval '2 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.players p
        WHERE p.room_id = r.id AND p.is_bot = false AND p.is_connected = true
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_unstuck FROM no_humans;

  RETURN jsonb_build_object(
    'finished_stale', v_finished,
    'finished_lobby', v_lobby,
    'finished_empty', v_unstuck,
    'at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_zombie_rooms() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.room_last_human_activity(uuid);
