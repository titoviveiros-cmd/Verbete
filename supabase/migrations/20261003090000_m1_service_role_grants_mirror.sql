-- =============================================================================
-- M1 · Espelho dos privilégios da chave de serviço (service_role)
--
-- Por quê: o Supabase LOCAL do CI nasce sem os privilégios padrão de tabela
-- (o baseline da Fase 0 veio de um dump sem eles). 20260722120000 espelhou os
-- de anon/authenticated, mas não os de service_role — no CI, as edges (que
-- usam a chave de serviço) levavam 42501 "permission denied for table rooms"
-- e o teste de ponta a ponta da IA não tinha como passar. Em produção, o
-- padrão do Supabase hospedado já concede ALL a service_role em public (a
-- edge score-similarity leu definitions em produção em 2026-07-29), então
-- reaplicar lá é NO-OP — e, se algum privilégio faltar, é exatamente o que
-- as edges do M1 precisam (rooms, rounds, words, definitions, ops_events).
--
-- Não toca anon/authenticated (o endurecimento do M1 vem na migration
-- seguinte). service_role já ignora RLS por definição; isto só alinha os
-- GRANTs de tabela/sequência ao padrão do Supabase.
--
-- ROLLBACK: não recomendado (quebraria as edges e as server functions).
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM service_role; etc.
-- =============================================================================

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Tabelas/sequências futuras (ex.: ops_heartbeat e ops_alerts deste M1).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
