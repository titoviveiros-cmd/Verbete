-- ROLLBACK de 20261111140000_sala_trancada_partida_rapida.sql: salas voltam a
-- aceitar qualquer pessoa com o código e a partida rápida volta a funcionar
-- pela API. A coluna rooms.locked sai (o estado "trancada" se perde).
--   npx supabase db query --linked -f supabase/rollback/sala_trancada_partida_rapida.sql
DROP TRIGGER IF EXISTS players_room_access_guard ON public.players;
DROP FUNCTION IF EXISTS public.players_room_access_guard();
DROP FUNCTION IF EXISTS public.set_room_locked(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.public_rooms_open();
ALTER TABLE public.rooms DROP COLUMN IF EXISTS locked;
