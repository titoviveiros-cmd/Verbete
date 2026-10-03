// Gera os scripts de rollback do M1 a partir das PRÓPRIAS migrations: para
// cada função que o M1 redefine, copia a última versão anterior a 20261003.
// Saída (versionada e testada no CI por scripts/test-rollback.mjs):
//   supabase/rollback/m1_full_rollback.sql      — volta o comportamento pré-M1
//   supabase/rollback/cleanup_zombie_rooms_v1.sql — desfaz a manutenção separada
// Uso: node scripts/gen-m1-rollback.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql") && f < "20261003")
  .sort();

function lastDefinition(name) {
  let found = null;
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "gi");
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), "utf8");
    for (const m of sql.matchAll(re)) found = { file: f, sql, start: m.index };
  }
  if (!found) throw new Error(`sem definição anterior para ${name}`);
  const { sql, start } = found;
  const rest = sql.slice(start);
  const asMatch = rest.match(/\bAS\s+(\$[a-z_]*\$)/i);
  if (!asMatch) throw new Error(`corpo não encontrado: ${name}`);
  const tag = asMatch[1];
  const bodyStart = start + asMatch.index + asMatch[0].length;
  const bodyEnd = sql.indexOf(tag, bodyStart);
  const semi = sql.indexOf(";", bodyEnd + tag.length);
  return { file: found.file, stmt: sql.slice(start, semi + 1) };
}

// create_room_with_host volta ao corpo antigo mas segue SECURITY DEFINER:
// a versão INVOKER dependia de INSERT direto em rooms/players, que o
// rollback funcional não reabre.
function keepDefiner(stmt) {
  return /SECURITY\s+DEFINER/i.test(stmt)
    ? stmt
    : stmt.replace(/LANGUAGE\s+plpgsql/i, "LANGUAGE plpgsql\nSECURITY DEFINER");
}

const restore = [
  "tick_stalled_rooms",
  "admin_ops_summary",
  "start_shuffling",
  "advance_writing_to_voting",
  "assert_actor_identity",
  "guard_author_identity",
  "create_room_with_host",
  "rejoin_room",
  "join_public_room",
  "leave_room",
  "submit_definition",
  "cast_vote",
  "submit_bot_definitions_bulk",
  "cast_votes_bulk",
  "record_match_result",
];

const parts = [
  `-- =============================================================================
-- M1 · ROLLBACK FUNCIONAL (gerado por scripts/gen-m1-rollback.mjs — não editar)
-- Volta o comportamento pré-M1 das RPCs, do tick e do painel, remove os
-- objetos novos e reabre só o que o client pré-M1 usa (INSERT de bot em
-- players, UPDATE de rooms.host_id). NÃO reabre furos que nenhum client usava:
-- apply_similarity_bonus, insert_truth_definition, escrita direta em
-- definitions/rounds/reactions/room_words/round_extensions seguem fechados.
-- O espelho de privilégios da service_role (20261003090000) FICA: é o padrão
-- do Supabase e as edges dependem dele.
-- Ordem em produção (sem janela): m1_compat_old_client.sql → voltar o web
-- (wrangler rollback) → isto → supabase migration repair --status reverted.
-- Testado no CI dentro de uma transação (scripts/test-rollback.mjs).
-- =============================================================================

-- Lote H
DROP FUNCTION IF EXISTS public.get_client_config();

-- Lote F
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-ops-health') THEN
    PERFORM cron.unschedule('verbete-ops-health');
  END IF;
END $rb$;
DROP FUNCTION IF EXISTS public.ops_health_check();
`,
];
for (const name of restore) {
  const { file, stmt } = lastDefinition(name);
  parts.push(`-- ${name} ← ${file}\n${name === "create_room_with_host" ? keepDefiner(stmt) : stmt}\n`);
}
parts.push(`DROP TABLE IF EXISTS public.ops_alerts;
DROP TABLE IF EXISTS public.ops_heartbeat;

-- Lote A: objetos novos
DROP FUNCTION IF EXISTS public.migrate_host(uuid);
DROP FUNCTION IF EXISTS public.add_bot(uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.is_sessionless_api_call();

-- Caminhos de escrita que o client pré-M1 usa (bots e migração de host);
-- INSERT só nas colunas do addBot antigo (score/user_id seguem protegidos)
GRANT INSERT (id, room_id, nickname, avatar, color, is_bot) ON public.players TO anon, authenticated;
DROP POLICY IF EXISTS "players public insert" ON public.players;
CREATE POLICY "players public insert" ON public.players FOR INSERT TO public WITH CHECK (true);
GRANT UPDATE (host_id) ON public.rooms TO anon, authenticated;
DROP POLICY IF EXISTS "rooms public update" ON public.rooms;
CREATE POLICY "rooms public update" ON public.rooms FOR UPDATE TO public USING (true) WITH CHECK (true);

-- Privilégios padrão do Supabase
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
`);

mkdirSync("supabase/rollback", { recursive: true });
writeFileSync("supabase/rollback/m1_full_rollback.sql", parts.join("\n"));

const cleanup = lastDefinition("cleanup_zombie_rooms");
writeFileSync(
  "supabase/rollback/cleanup_zombie_rooms_v1.sql",
  `-- Desfaz a manutenção cleanup_zombie_rooms v2 (gerado por scripts/gen-m1-rollback.mjs)
-- Restaura a regra antiga (${cleanup.file}). As salas que a v2 encerrou eram
-- resíduos parados; se precisar, reverter o status com o snapshot do dry-run.
${cleanup.stmt}

REVOKE ALL ON FUNCTION public.cleanup_zombie_rooms() FROM PUBLIC, anon, authenticated;
`,
);
console.log(`ok: ${restore.length} funções restauradas + cleanup v1`);
