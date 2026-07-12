-- Lock down internal SECURITY DEFINER functions: only service_role should call them.
-- These RPCs are invoked from server functions via the admin client; if anon
-- or authenticated could call them directly, they could bypass auth checks
-- (e.g. submit daily attempts for arbitrary user IDs, force-advance rooms).

REVOKE EXECUTE ON FUNCTION public.submit_daily_attempt_scored(uuid, text, integer, integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_daily_attempt(uuid, text, integer)                FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.advance_voting_to_reveal(uuid)                           FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.advance_reveal_to_scoreboard(uuid)                       FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.advance_writing_to_voting(uuid)                          FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tick_stalled_rooms()                                     FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_zombie_rooms()                                   FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                                        FROM anon, authenticated, PUBLIC;

-- daily_challenges has RLS enabled but no policy → effectively locked, but the
-- linter flags it. Add an explicit public-read policy (challenges are public
-- info: the word being challenged today). Writes stay restricted (only
-- SECURITY DEFINER functions running as service_role can insert/update).
CREATE POLICY "public read daily_challenges"
  ON public.daily_challenges
  FOR SELECT
  USING (true);

