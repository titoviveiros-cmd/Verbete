-- Fix: reset_room must bypass RLS to delete rounds (which has no DELETE policy)
CREATE OR REPLACE FUNCTION public.reset_room(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.players
    SET score = 0, coordinator_count = 0, writing_extensions = 0
    WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  UPDATE public.rooms SET
    status = 'lobby',
    current_round = 0,
    current_coordinator = NULL,
    current_word_id = NULL,
    round_phase_ends_at = NULL
  WHERE id = p_room_id;
END;
$function$;

-- Defense in depth: also add a DELETE policy on rounds so any legacy
-- client-side cleanup also works.
CREATE POLICY "rounds public delete"
  ON public.rounds
  FOR DELETE
  USING (room_id IS NOT NULL);

-- One-time cleanup: rooms currently in a broken state (rounds rows from a
-- previous match still present after a restart) get a fresh slate so the
-- next round can score correctly.
DELETE FROM public.rounds r
  WHERE EXISTS (
    SELECT 1 FROM public.rooms ro
    WHERE ro.id = r.room_id
      AND ro.status IN ('lobby','choosing','writing','voting','reveal','scoreboard')
      AND ro.current_round <= r.round
  );

