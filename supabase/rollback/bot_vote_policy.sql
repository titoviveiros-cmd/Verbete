-- Reversão da 20261022160000: remove a política de voto dos bots no
-- servidor. O cliente volta ao voto antigo sozinho (cast_votes_bulk) quando
-- cast_bot_votes não existe.

DROP FUNCTION IF EXISTS public.cast_bot_votes(uuid, integer, text);
DROP FUNCTION IF EXISTS public.bot_vote_pick(uuid, uuid[], double precision, double precision, double precision);
