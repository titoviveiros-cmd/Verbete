-- =============================================================================
-- Espelho dos GRANTs de produção (snapshot 2026-07-20 via scripts/dump-grants.mjs)
--
-- Por quê: o baseline da Fase 0 veio de um dump SEM os privilégios de tabela;
-- em produção os grants default do Supabase já existiam, mas o Supabase LOCAL
-- do CI nascia sem eles — REST como anon dava 42501 (permission denied) no
-- job de integração hermético.
--
-- Este snapshot já reflete a postura de segurança da Fase 1:
--   • definitions SEM SELECT (revogado — ninguém lê autores/verdade direto)
--   • words SEM SELECT de tabela; SELECT apenas nas colunas seguras
--     (meaning/curiosidade/origem/exemplo/sinonimos ficam ocultas)
--   • rooms sem UPDATE de tabela; UPDATE apenas em host_id
--
-- Reaplicar em produção é NO-OP (grants já existem; GRANT é idempotente).
-- RLS continua sendo o gate de linha; grants são a camada de coluna/verbo.
-- ROLLBACK: REVOKE dos statements abaixo (não recomendado — quebraria o client).
-- =============================================================================

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.achievements TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.banned_players TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.daily_attempts TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.daily_challenges TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON public.definitions TO anon, authenticated; -- SEM SELECT (Fase 1)
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.match_history TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.players TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profiles TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.reactions TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.reports TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.room_messages TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.room_words TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE ON public.rooms TO anon, authenticated; -- UPDATE só em host_id (abaixo)
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.round_extensions TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.rounds TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_achievements TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_roles TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_stats TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.votes TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON public.words TO anon, authenticated; -- SEM SELECT de tabela (Fase 1)

-- Grants por coluna (espelho exato)
GRANT UPDATE (host_id) ON public.rooms TO anon, authenticated;
GRANT SELECT (category, classe, created_at, id, nivel, pronuncia, rarity, word) ON public.words TO anon, authenticated;
