// Prova que os scripts de rollback do M1 aplicam limpos e fazem o que
// prometem — cada um dentro de uma transação desfeita no fim (o banco do CI
// segue no M1 para as outras suítes).
// Envs: DB_URL.
import pg from "pg";
import { readFileSync } from "node:fs";

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

const after = await one(`SELECT to_regprocedure('public.migrate_host(uuid)') IS NOT NULL AS m1`);
check("banco do CI segue no M1 após os testes (transações desfeitas)", after.m1);

await db.query(`DELETE FROM public.rooms WHERE id = $1`, [rid]);
await db.query(`DELETE FROM public.players WHERE id LIKE $1 OR id LIKE $2`, [`rb_%_${tag}`, `bot_r%${tag}`]);
await db.end();
console.log(fails ? `\n${fails}/${total} FALHAS` : `\nROLLBACK OK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
