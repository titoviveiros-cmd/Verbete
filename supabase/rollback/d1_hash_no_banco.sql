-- Rollback de 20261110120000_d1_hash_no_banco.sql: remove SÓ as 4 funções novas.
-- Nenhum dado, tabela ou função antiga é tocado. ANTES de rodar, volte o Worker
-- para uma versão que não chama as funções novas (qualquer uma anterior ao PR da R1).
DROP FUNCTION IF EXISTS public.daily_choice_admin_review_hashed(jsonb, uuid);
DROP FUNCTION IF EXISTS public.daily_choice_admin_edit_guarded(uuid, text[], jsonb, boolean, boolean);
DROP FUNCTION IF EXISTS public.daily_choice_set_hash(uuid, text, text[]);
DROP FUNCTION IF EXISTS public.daily_choice_alt_ok(text[]);
