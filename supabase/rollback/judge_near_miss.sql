-- ROLLBACK de 20261102130000_judge_near_miss.sql: some o "Quase lá" (a edge
-- antiga não chama apply_similarity_near_miss; a nova só registra aviso se a
-- função não existir). Juiz e bônus +3 não dependem disto.
--   npx supabase db query --linked -f supabase/rollback/judge_near_miss.sql
DROP FUNCTION IF EXISTS public.get_my_near_miss(uuid, text);
DROP FUNCTION IF EXISTS public.apply_similarity_near_miss(uuid, int, uuid[]);
DROP TABLE IF EXISTS public.definition_near_miss;
