-- Pré-voo do M1 em produção — SOMENTE LEITURA (rodar com scripts/sql-readonly.mjs).
-- Escolher um momento sem partida em andamento e confirmar o estado das
-- migrations e dos privilégios da chave de serviço antes do db push.
SELECT 'partidas em andamento (prazo nos últimos 15 min)' AS item, count(*)::text AS valor
  FROM public.rooms
 WHERE status NOT IN ('lobby', 'finished')
   AND round_phase_ends_at > now() - interval '15 minutes'
UNION ALL
SELECT 'lobbies criados nos últimos 15 min', count(*)::text
  FROM public.rooms
 WHERE status = 'lobby' AND created_at > now() - interval '15 minutes'
UNION ALL
SELECT 'última migration aplicada', max(version)
  FROM supabase_migrations.schema_migrations
UNION ALL
SELECT 'migrations do M1 já aplicadas (esperado 0)', count(*)::text
  FROM supabase_migrations.schema_migrations
 WHERE version >= '20261003000000'
UNION ALL
-- o espelho 20261003090000 garante estes; aqui só se registra o estado atual
SELECT 'chave de serviço SEM o privilégio que as edges usam (esperado: nenhum)',
       COALESCE(string_agg(t.tbl || ':' || t.priv, ', '), 'nenhum')
  FROM (VALUES ('rooms','SELECT'), ('rounds','SELECT'), ('words','SELECT'), ('room_words','SELECT'),
               ('definitions','SELECT'), ('ai_served_defs','INSERT'), ('ops_events','INSERT')) AS t(tbl, priv)
 WHERE NOT has_table_privilege('service_role', 'public.' || t.tbl, t.priv);
