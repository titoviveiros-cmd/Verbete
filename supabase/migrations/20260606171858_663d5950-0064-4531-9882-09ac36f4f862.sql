-- Defensive baseline: re-assert that is_truth/near_truth on definitions
-- are NEVER readable by clients via PostgREST. The reveal phase fetches
-- these flags through SECURITY DEFINER RPCs (get_round_reveal / get_room_reveal),
-- so anon/authenticated must not have column SELECT on them.
REVOKE SELECT (is_truth, near_truth) ON public.definitions FROM anon, authenticated, public;

-- Make sure inserts still work (the host/coordinator client inserts truth rows
-- via the SECURITY DEFINER advance_writing_to_voting function, but the
-- pre-existing INSERT policy on definitions allows clients to insert their own
-- player definitions — keep that path intact).
GRANT INSERT (room_id, round, player_id, "text") ON public.definitions TO anon, authenticated;

