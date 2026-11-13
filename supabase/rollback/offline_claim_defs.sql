-- Rollback de 20261112100000_offline_claim_defs.sql (G3 opção C, PR #62).
-- Remove só a função. ai_served_defs e os dados ficam intactos. As edges
-- tratam a função ausente como "reserva indisponível" e voltam sozinhas ao
-- caminho de antes (releitura + upsert ON CONFLICT + keepClaimed).
DROP FUNCTION IF EXISTS public.offline_claim_defs(uuid, integer, text[], integer);
