-- 1) Revoke EXECUTE on internal phase-transition RPCs (only cron/service_role should call them)
REVOKE EXECUTE ON FUNCTION public.tick_stalled_rooms() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.advance_writing_to_voting(uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.advance_voting_to_reveal(uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.advance_reveal_to_scoreboard(uuid) FROM anon, authenticated, public;

-- 2) Tighten RLS on rooms — keep read/insert/update open (game logic depends on it), but BLOCK DELETE
DROP POLICY IF EXISTS "public write rooms" ON public.rooms;
CREATE POLICY "rooms public insert" ON public.rooms FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "rooms public update" ON public.rooms FOR UPDATE TO public USING (true) WITH CHECK (true);
-- (no DELETE policy → deletes blocked for non-owner roles)

-- 3) Tighten RLS on reactions — block DELETE (no legit client deletes reactions)
DROP POLICY IF EXISTS "public write reactions" ON public.reactions;
CREATE POLICY "reactions public insert" ON public.reactions FOR INSERT TO public WITH CHECK (true);

-- 4) Tighten RLS on definitions/votes — allow insert+update (game needs both for letters/scoring) and DELETE only for rows scoped to a room (still permissive but prevents non-room-scoped wipes; clients legitimately delete by room_id via reset paths)
DROP POLICY IF EXISTS "public write definitions" ON public.definitions;
CREATE POLICY "definitions public insert" ON public.definitions FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "definitions public update" ON public.definitions FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "definitions public delete" ON public.definitions FOR DELETE TO public USING (room_id IS NOT NULL);

DROP POLICY IF EXISTS "public write votes" ON public.votes;
CREATE POLICY "votes public insert" ON public.votes FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "votes public delete" ON public.votes FOR DELETE TO public USING (room_id IS NOT NULL);
-- votes don't need UPDATE

-- 5) Players — allow insert/update/delete (leaveRoom needs delete), keep open but split for clarity
DROP POLICY IF EXISTS "public write players" ON public.players;
CREATE POLICY "players public insert" ON public.players FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "players public update" ON public.players FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "players public delete" ON public.players FOR DELETE TO public USING (true);

