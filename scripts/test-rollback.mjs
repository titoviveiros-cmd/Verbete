// Prova que os scripts de rollback do M1 aplicam limpos e fazem o que
// prometem — cada um dentro de uma transação desfeita no fim (o banco do CI
// segue no M1 para as outras suítes).
// Envs: DB_URL.
import pg from "pg";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL_FASES_SEM_IA, SQL_PRONTIDAO_SEM_IA } from "./lib/sem-ia-prontidao.mjs";

const db = new pg.Client({
  connectionString: process.env.DB_URL,
  ssl: /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false,
});
await db.connect();
let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const tag = Math.random().toString(36).slice(2, 7);

// sala de apoio (fora das transações)
const { id: rid } = await one(
  `INSERT INTO public.rooms (code, host_id, status) VALUES ($1, $2, 'lobby') RETURNING id`,
  [`R${tag}`, `rb_h_${tag}`],
);
await db.query(
  `INSERT INTO public.players (id, room_id, nickname, avatar, color) VALUES ($1, $2, 'H', 'h', '#000')`,
  [`rb_h_${tag}`, rid],
);

// Executa como o client da API (papel anon), sem sessão.
async function asAnon(sql, params) {
  await db.query("SAVEPOINT a");
  try {
    await db.query("SET LOCAL ROLE anon");
    const r = await db.query(sql, params);
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT a");
    return { ok: true, rowCount: r.rowCount };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT a");
    return { ok: false, err: e.message };
  }
}

console.log("— Rollback de compatibilidade (web pré-M1 + banco M1)");
await db.query("BEGIN");
try {
  await db.query(readFileSync("supabase/rollback/m1_compat_old_client.sql", "utf8"));
  check("aplica sem erro", true);
  let r = await asAnon(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot) VALUES ($1, $2, 'Bot', 'b', '#111', true)`,
    [`bot_rb${tag}`, rid],
  );
  check("o addBot do client antigo volta a funcionar", r.ok, r.err);
  r = await asAnon(`UPDATE public.rooms SET host_id = $2 WHERE id = $1 AND host_id = $3`, [rid, `bot_rb${tag}`, `rb_h_${tag}`]);
  check("o migrateHost do client antigo volta a funcionar", r.ok && r.rowCount === 1, r.err);
  r = await asAnon(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, score) VALUES ($1, $2, 'X', 'x', '#000', 999)`,
    [`rb_x_${tag}`, rid],
  );
  check("inserir jogador JÁ com pontos continua barrado", !r.ok, r.err?.slice(0, 80));
  r = await asAnon(`UPDATE public.players SET score = 999 WHERE id = $1`, [`rb_h_${tag}`]);
  check("UPDATE de placar continua barrado", !r.ok, r.err?.slice(0, 80));
  r = await asAnon(`INSERT INTO public.rounds (room_id, round) VALUES ($1, 1)`, [rid]);
  check("INSERT em rounds continua barrado", !r.ok, r.err?.slice(0, 80));
} finally {
  await db.query("ROLLBACK");
}

console.log("\n— Rollback funcional completo");
await db.query("BEGIN");
try {
  await db.query(readFileSync("supabase/rollback/m1_full_rollback.sql", "utf8"));
  check("aplica sem erro", true);
  const s = await one(`
    SELECT to_regprocedure('public.migrate_host(uuid)') IS NULL AS no_migrate,
           to_regprocedure('public.add_bot(uuid,text,text,text,text,text)') IS NULL AS no_addbot,
           to_regprocedure('public.get_client_config()') IS NULL AS no_cfg,
           to_regprocedure('public.ops_health_check()') IS NULL AS no_health,
           to_regprocedure('public.is_sessionless_api_call()') IS NULL AS no_helper,
           to_regclass('public.ops_alerts') IS NULL AS no_alerts,
           to_regclass('public.ops_heartbeat') IS NULL AS no_hb,
           NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-ops-health') AS no_job,
           EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-tick-stalled-rooms') AS tick_job`);
  check("objetos novos removidos e o cron do motor preservado", Object.values(s).every(Boolean), JSON.stringify(s));
  const defs = await one(`
    SELECT pg_get_functiondef('public.start_shuffling(uuid)'::regprocedure) NOT LIKE '%pending_players%' AS shuffle_old,
           pg_get_functiondef('public.assert_actor_identity(uuid,text)'::regprocedure) NOT LIKE '%session_required%' AS assert_old,
           pg_get_functiondef('public.tick_stalled_rooms()'::regprocedure) NOT LIKE '%ops_heartbeat%' AS tick_old,
           (SELECT prosecdef FROM pg_proc WHERE oid = 'public.create_room_with_host(text,text,text,text)'::regprocedure) AS create_definer`);
  check("funções voltaram ao corpo pré-M1 (create_room_with_host segue DEFINER)", Object.values(defs).every(Boolean), JSON.stringify(defs));
  const t = await one(`SELECT public.tick_stalled_rooms() AS r`);
  check("tick antigo roda", !!t.r, JSON.stringify(t.r).slice(0, 80));
  const r = await asAnon(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot) VALUES ($1, $2, 'Bot', 'b', '#111', true)`,
    [`bot_rf${tag}`, rid],
  );
  check("client pré-M1 volta a adicionar bot", r.ok, r.err);
  const holes = await one(`
    SELECT has_function_privilege('anon', 'public.apply_similarity_bonus(uuid,integer,uuid[])', 'EXECUTE') AS bonus,
           has_function_privilege('anon', 'public.insert_truth_definition(uuid,integer,text)', 'EXECUTE') AS truth,
           has_table_privilege('anon', 'public.definitions', 'UPDATE') AS defs_update,
           has_table_privilege('anon', 'public.rounds', 'INSERT') AS rounds_insert`);
  check("furos que nenhum client usava continuam fechados", !Object.values(holes).some(Boolean), JSON.stringify(holes));
} finally {
  await db.query("ROLLBACK");
}

console.log("\n— Rollback da manutenção (cleanup v1)");
await db.query("BEGIN");
try {
  await db.query(readFileSync("supabase/rollback/cleanup_zombie_rooms_v1.sql", "utf8"));
  const c = await one(`SELECT public.cleanup_zombie_rooms() AS r`);
  check("regra antiga restaurada e executável", !!c.r && !("finished_lobby" in c.r), JSON.stringify(c.r).slice(0, 100));
} finally {
  await db.query("ROLLBACK");
}

console.log("\n— Ferramentas do runbook de produção (mesmos comandos que o dono vai rodar)");
const node = (args) =>
  spawnSync(process.execPath, args, { encoding: "utf8", env: process.env });
let t = node(["scripts/sql-apply.mjs", "supabase/rollback/m1_compat_old_client.sql"]);
const policyAfterRehearsal = await one(
  `SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'players' AND policyname = 'players public insert'`,
);
check(
  "sql-apply sem --commit é ensaio: aplica sem erro e não grava nada",
  t.status === 0 && /ENSAIO/.test(t.stdout) && policyAfterRehearsal.n === 0,
  `exit=${t.status} política=${policyAfterRehearsal.n} ${(t.stdout + t.stderr).trim().slice(0, 120)}`,
);
const bad = join(tmpdir(), `m1-bad-${tag}.sql`);
writeFileSync(bad, `CREATE TABLE public.tmp_rb_${tag} (id int);\nSELECT 1/0;\n`);
t = node(["scripts/sql-apply.mjs", bad, "--commit"]);
const leftover = await one(`SELECT to_regclass('public.tmp_rb_${tag}') IS NULL AS clean`);
check(
  "sql-apply --commit com erro no meio: tudo ou nada (nada gravado)",
  t.status === 1 && leftover.clean,
  `exit=${t.status} ${(t.stderr || t.stdout).trim().slice(0, 120)}`,
);
for (const f of [
  "supabase/maintenance/m1_preflight_readonly.sql",
  "supabase/maintenance/20261003_cleanup_zombie_rooms_v2_dryrun.sql",
]) {
  t = node(["scripts/sql-readonly.mjs", f]);
  check(`sql-readonly roda ${f.split("/").pop()}`, t.status === 0, `exit=${t.status} ${t.stderr.trim().slice(0, 120)}`);
}

const original = (await one(`SELECT value FROM public.app_config WHERE key = 'client.maintenance'`))?.value;
t = node(["scripts/set-app-config.mjs", "client.maintenance", "on"]);
const cfgOn = (await one(`SELECT public.get_client_config() AS c`)).c;
t = original === undefined
  ? node(["scripts/set-app-config.mjs", "client.maintenance", "--delete"])
  : node(["scripts/set-app-config.mjs", "client.maintenance", original]);
const restored = (await one(`SELECT value FROM public.app_config WHERE key = 'client.maintenance'`))?.value;
check(
  "set-app-config liga a manutenção (o app lê via get_client_config) e volta ao valor anterior",
  cfgOn?.maintenance === "on" && t.status === 0 && restored === original,
  `${JSON.stringify(cfgOn)} restaurado=${restored}`,
);
const denied = [
  node(["scripts/set-app-config.mjs", "supabase_anon_key", "x"]).status,
  node(["scripts/set-app-config.mjs", "client.maintenance", "talvez"]).status,
  node(["scripts/set-app-config.mjs", "ops_alert_webhook_url", "http://inseguro"]).status,
];
check("set-app-config recusa chave fora da lista e valor inválido", denied.every((s) => s === 2), JSON.stringify(denied));

// Trava dos 168 (11/11/2026, scripts/lib/sem-ia-prontidao.mjs): a consulta
// REAL contra o banco migrado e o set-app-config REAL recusando sem estoque.
const cfgVal = async (k) => (await one(`SELECT value FROM public.app_config WHERE key = $1`, [k]))?.value;
const restoreCfg = async (k, v) =>
  v === undefined
    ? db.query(`DELETE FROM public.app_config WHERE key = $1`, [k])
    : db.query(
        `INSERT INTO public.app_config (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [k, v],
      );
const aiOrig = await cfgVal("ai_mode");
const dmOrig = await cfgVal("daily_mode");
const pront = await one(SQL_PRONTIDAO_SEM_IA);
check(
  "trava 168: a consulta de prontidão roda no banco migrado (mesmo critério do painel)",
  Number.isInteger(pront?.aprovado_jogavel),
  JSON.stringify(pront),
);
if (pront.aprovado_jogavel < 168) {
  const aiTry = node(["scripts/set-app-config.mjs", "ai_mode", "suspenso"]);
  check(
    "trava 168: ai_mode=suspenso RECUSADO sem estoque (exit 3, nada gravado)",
    aiTry.status === 3 && (await cfgVal("ai_mode")) === aiOrig,
    `exit=${aiTry.status} ${aiTry.stderr.trim().slice(0, 140)}`,
  );
  const dmTry = node(["scripts/set-app-config.mjs", "daily_mode", "escolha"]);
  check(
    "trava 168: daily_mode=escolha RECUSADO sem estoque (exit 3, nada gravado)",
    dmTry.status === 3 && (await cfgVal("daily_mode")) === dmOrig,
    `exit=${dmTry.status} ${dmTry.stderr.trim().slice(0, 140)}`,
  );
  const gate = node(["scripts/check-sem-ia-prontidao.mjs"]);
  check("trava 168: portão só de leitura sai 1 (não pronto)", gate.status === 1, `exit=${gate.status}`);
  // R3: a consulta dos portões por fase roda no banco migrado (colunas e
  // tipos reais) e cada fase bloqueia sem estoque
  const fases = await one(SQL_FASES_SEM_IA);
  check(
    "portões por fase: a consulta roda no banco migrado (só leitura)",
    Number.isInteger(fases?.aprovado_jogavel) && Number.isInteger(fases?.ia_24h) && Array.isArray(fases?.fns_suspensas_1h),
    JSON.stringify(fases),
  );
  const porFase = ["escolha", "suspender", "textos", "revogar"].map(
    (f) => node(["scripts/check-sem-ia-prontidao.mjs", "--fase", f]).status,
  );
  check("portões por fase: as 4 fases saem 1 sem estoque", porFase.every((s) => s === 1), JSON.stringify(porFase));
  const emer = node(["scripts/set-app-config.mjs", "ai_mode", "suspenso", "--emergencia"]);
  const emerVal = await cfgVal("ai_mode");
  await restoreCfg("ai_mode", aiOrig);
  check(
    "trava 168: contenção de emergência (--emergencia) continua possível e avisa",
    emer.status === 0 && emerVal === "suspenso" && /EMERGÊNCIA/.test(emer.stderr),
    `exit=${emer.status} valor=${emerVal}`,
  );
  const back = node(["scripts/set-app-config.mjs", "ai_mode", "ligado"]);
  await restoreCfg("ai_mode", aiOrig);
  check("trava 168: rollback ai_mode=ligado nunca é barrado", back.status === 0, `exit=${back.status}`);
} else {
  check("trava 168: banco do CI já tem ≥ 168 aprovados — casos negativos pulados", true);
}
await restoreCfg("ai_mode", aiOrig);
await restoreCfg("daily_mode", dmOrig);

const after = await one(`SELECT to_regprocedure('public.migrate_host(uuid)') IS NOT NULL AS m1`);
check("banco do CI segue no M1 após os testes (transações desfeitas)", after.m1);

await db.query(`DELETE FROM public.rooms WHERE id = $1`, [rid]);
await db.query(`DELETE FROM public.players WHERE id LIKE $1 OR id LIKE $2`, [`rb_%_${tag}`, `bot_r%${tag}`]);
await db.end();
console.log(fails ? `\n${fails}/${total} FALHAS` : `\nROLLBACK OK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
