-- =============================================================================
-- M1 · ROLLBACK DE COMPATIBILIDADE — client pré-M1 (17bb348) com o banco novo
--
-- Usar se o WEB for revertido para a versão pré-M1 e o banco ficar no M1: o
-- client antigo adiciona bots e migra host por escrita direta. Reabre APENAS
-- esses dois caminhos; todo o resto do endurecimento continua valendo
-- (pontuação, definições, rounds, verdade, bônus seguem protegidos).
-- Testado no CI dentro de uma transação (scripts/test-rollback.mjs).
-- =============================================================================

-- Só as colunas do addBot antigo: score/user_id/kicked_at seguem fora do
-- alcance (o padrão 0/NULL vale), mesmo neste modo de emergência.
GRANT INSERT (id, room_id, nickname, avatar, color, is_bot) ON public.players TO anon, authenticated;
DROP POLICY IF EXISTS "players public insert" ON public.players;
CREATE POLICY "players public insert" ON public.players FOR INSERT TO public WITH CHECK (true);

GRANT UPDATE (host_id) ON public.rooms TO anon, authenticated;
DROP POLICY IF EXISTS "rooms public update" ON public.rooms;
CREATE POLICY "rooms public update" ON public.rooms FOR UPDATE TO public USING (true) WITH CHECK (true);
