GRANT EXECUTE ON FUNCTION public.extend_writing_or_advance(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_writing_to_voting(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_voting_to_reveal(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_reveal_to_scoreboard(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_room(uuid) TO anon, authenticated;

