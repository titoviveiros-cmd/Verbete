-- Voto dos bots SÓ pela política do servidor (cast_bot_votes, migration
-- 20261022160000). O caminho legado cast_votes_bulk deixava o HOST escolher a
-- cédula de cada bot (Red Team de 2026-10-22: P2 para depois do merge).
-- Revogado depois que o cliente novo (PR #9, faa1366) entrou no ar usando
-- cast_bot_votes. A função continua existindo para o motor (SQL interno /
-- service_role) — só deixa de ser chamável por anon/authenticated. O cliente
-- novo só cairia nela se cast_bot_votes não existisse (PGRST202/42883).
-- Reversão: supabase/rollback/revoke_cast_votes_bulk.sql
REVOKE EXECUTE ON FUNCTION public.cast_votes_bulk(uuid, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
