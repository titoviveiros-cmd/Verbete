-- ROLLBACK de 20261111120000_ugc_filtro_servidor.sql: os gatilhos e as
-- funções novas saem; definitions, players, profiles, reactions e a
-- configuração da sala (categorias e times) voltam a aceitar qualquer texto no
-- servidor (o cliente segue filtrando). Nenhum dado muda.
--   npx supabase db query --linked -f supabase/rollback/ugc_filtro_servidor.sql
DROP TRIGGER IF EXISTS definitions_ugc_guard ON public.definitions;
DROP TRIGGER IF EXISTS players_nickname_ugc_guard ON public.players;
DROP TRIGGER IF EXISTS profiles_display_name_ugc_guard ON public.profiles;
DROP TRIGGER IF EXISTS reactions_ugc_guard ON public.reactions;
DROP TRIGGER IF EXISTS rooms_config_ugc_guard ON public.rooms;
DROP FUNCTION IF EXISTS public.definitions_ugc_guard();
DROP FUNCTION IF EXISTS public.players_nickname_ugc_guard();
DROP FUNCTION IF EXISTS public.profiles_display_name_ugc_guard();
DROP FUNCTION IF EXISTS public.reactions_ugc_guard();
DROP FUNCTION IF EXISTS public.rooms_config_ugc_guard();
DROP FUNCTION IF EXISTS public.room_config_issue(text[], jsonb);
DROP FUNCTION IF EXISTS public.ugc_symbol_issue(text);
DROP FUNCTION IF EXISTS public.ugc_text_issue(text);
