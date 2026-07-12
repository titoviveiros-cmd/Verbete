
-- Hide the 'meaning' column on the public dictionary table from anon/authenticated.
-- Only SECURITY DEFINER functions and the service role (edge functions / RPCs)
-- can read meanings. PostgREST `select=*` will return all OTHER allowed columns
-- silently, so client code that selects specific columns keeps working.
REVOKE SELECT (meaning) ON public.words FROM anon, authenticated, PUBLIC;


