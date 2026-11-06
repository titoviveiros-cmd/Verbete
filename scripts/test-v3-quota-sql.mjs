// V3 (edges de IA): a cota dos bots no BANCO — bots_quota_take, permissões e
// concorrência. Nasceu da falha da CI do PR #42 (run 42141677897): a edge
// chamava ai_quota_add (V2) com a chave de serviço e levava 42501 → o convidado
// legítimo recebia 503 guard_error e a cota nunca contava.
//   node scripts/test-v3-quota-sql.mjs                 (CI: Postgres real, DB_URL local)
//   node scripts/test-v3-quota-sql.mjs --pglite <pasta do @electric-sql/pglite>  (ensaio local)
// No modo pg roda DEPOIS do test-daily-guard (que apaga e recria as funções da
// V2): prova que a cota da V3 não depende dos grants da V2.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = readFileSync(join(ROOT, "supabase/migrations/20261105180000_bots_auth_guard_v3.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollback/bots_auth_guard_v3.sql"), "utf8");
const args = process.argv.slice(2);
const pglitePath = args.includes("--pglite") ? args[args.indexOf("--pglite") + 1] : null;
const modePg = !pglitePath;
const { DB_URL } = process.env;

if (modePg) {
  if (!DB_URL) {
    console.error("✖ DB_URL ausente: este teste NÃO pode passar sem um Postgres real (use --pglite só para o ensaio local).");
    process.exit(1);
  }
  const host = new URL(DB_URL).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    console.error(`✖ recusado: DB_URL aponta para "${host}". Este teste altera dados e só roda em banco LOCAL.`);
    process.exit(1);
  }
}

let db; // { q, exec, close, conn }
if (modePg) {
  const { default: pg } = await import("pg");
  const mk = async () => {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    return c;
  };
  const main = await mk();
  db = { q: async (s, p = []) => (await main.query(s, p)).rows, exec: (s) => main.query(s), close: () => main.end(), conn: mk };
} else {
  const { PGlite } = await import(pathToFileURL(join(pglitePath, "dist", "index.js")).href);
  const pgl = await PGlite.create();
  db = { q: async (s, p = []) => (await pgl.query(s, p)).rows, exec: (s) => pgl.exec(s), close: () => pgl.close(), conn: null };
  // esquema mínimo: o que a V3 usa (app_config + ai_quota da V2) e os papéis do Supabase
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.app_config (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.ai_quota (key text NOT NULL, window_start timestamptz NOT NULL,
      used integer NOT NULL DEFAULT 0 CHECK (used >= 0), PRIMARY KEY (key, window_start));
    ALTER TABLE public.ai_quota ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.ai_quota FROM PUBLIC, anon, authenticated;
  `);
  await db.exec(MIG);
}

let pass = 0;
let fail = 0;
async function t(nome, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✔ ${nome}`);
  } catch (e) {
    fail++;
    console.log(`  ✖ ${nome}\n      ${e?.message ?? e}`);
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg ?? "diferente"}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
};
const ok = (v, msg) => {
  if (!v) throw new Error(msg ?? "falso");
};
const FN = "public.bots_quota_take(uuid,integer)";
const take = async (room, round, q = db.q) => (await q(`SELECT public.bots_quota_take($1, $2) AS n`, [room, round]))[0].n;
const salas = [];
const novaSala = () => {
  const id = randomUUID();
  salas.push(id);
  return id;
};

console.log(`V3 cota dos bots — modo ${modePg ? "pg (Postgres real)" : "PGlite (offline, 1 conexão)"}`);

await t("1. configuração: padrão observar e limite 60", async () => {
  const cfg = Object.fromEntries(
    (await db.q(`SELECT key, value FROM public.app_config WHERE key IN ('bots_auth_mode', 'bots_ai_round_limit')`)).map((r) => [r.key, r.value]),
  );
  // no pg, outras suítes podem ter mexido no modo e devolvido 'observar'
  eq(cfg.bots_auth_mode, "observar", "modo");
  eq(cfg.bots_ai_round_limit, "60", "limite");
});

await t("2. permissões: só service_role executa bots_quota_take; SECURITY DEFINER com search_path fixo", async () => {
  for (const r of ["anon", "authenticated"])
    eq((await db.q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS p`, [r, FN]))[0].p, false, `${r} executa`);
  eq((await db.q(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS p`, [FN]))[0].p, true, "service_role executa");
  const f = (await db.q(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure`, [FN]))[0];
  ok(f.prosecdef, "não é SECURITY DEFINER");
  ok(String(f.proconfig).includes("search_path=public, pg_temp"), `search_path: ${f.proconfig}`);
  // diagnóstico da causa raiz (informativo: a V3 não depende mais disso)
  const v2 = await db.q(
    `SELECT has_function_privilege('service_role', 'public.ai_quota_add(text,integer)', 'EXECUTE') AS p
      WHERE to_regprocedure('public.ai_quota_add(text,integer)') IS NOT NULL`,
  );
  console.log(`      (ai_quota_add da V2 para service_role: ${v2.length ? v2[0].p : "função ausente"})`);
});

await t("3. como service_role: conta 1, 2, 3 por sala/rodada; chave montada no banco", async () => {
  const sala = novaSala();
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE service_role");
    eq([await take(sala, 1), await take(sala, 1), await take(sala, 1)], [1, 2, 3], "contagem");
    eq(await take(sala, 2), 1, "rodada nova = contador novo");
    await db.exec("RESET ROLE");
    const rows = await db.q(`SELECT key, used FROM public.ai_quota WHERE key LIKE $1 ORDER BY key`, [`bots_round:${sala}:%`]);
    eq(rows.map((r) => [r.key, r.used]), [[`bots_round:${sala}:1`, 3], [`bots_round:${sala}:2`, 1]], "linhas");
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
});

await t("4. anon e authenticated: sem permissão (42501), nada contado", async () => {
  const sala = novaSala();
  for (const r of ["anon", "authenticated"]) {
    await db.exec("BEGIN");
    let code = null;
    try {
      await db.exec(`SET LOCAL ROLE ${r}`);
      await take(sala, 1);
    } catch (e) {
      code = e.code ?? null;
    }
    await db.exec("ROLLBACK");
    eq(code, "42501", `${r} executou`);
  }
  eq((await db.q(`SELECT count(*)::int AS n FROM public.ai_quota WHERE key LIKE $1`, [`bots_round:${sala}:%`]))[0].n, 0, "contou");
});

await t("5. sala/rodada nulas: erro 22023, nada contado", async () => {
  for (const [s, r] of [[null, 1], [randomUUID(), null]]) {
    let code = null;
    try {
      await take(s, r);
    } catch (e) {
      code = e.code ?? null;
    }
    eq(code, "22023", JSON.stringify([s, r]));
  }
});

await t("6. concorrência: N pedidos simultâneos recebem totais distintos 1..N (no máximo `limite` passam)", async () => {
  const sala = novaSala();
  const N = 12;
  const LIMITE = 7;
  let totais;
  if (modePg) {
    const conns = await Promise.all(Array.from({ length: N }, () => db.conn()));
    try {
      // todos esperam no mesmo instante: cada conexão abre transação e chama junto
      totais = await Promise.all(
        conns.map(async (c) => {
          await c.query("BEGIN");
          await c.query("SET LOCAL ROLE service_role");
          const n = (await c.query(`SELECT public.bots_quota_take($1, 1) AS n`, [sala])).rows[0].n;
          await c.query("COMMIT");
          return n;
        }),
      );
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  } else {
    totais = [];
    for (let i = 0; i < N; i++) totais.push(await take(sala, 1));
  }
  eq([...totais].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 1), "totais");
  eq(totais.filter((n) => n <= LIMITE).length, LIMITE, "passariam");
  eq((await db.q(`SELECT used FROM public.ai_quota WHERE key = $1`, [`bots_round:${sala}:1`]))[0].used, N, "contador final");
});

await t("7. reaplicar a migration não sobrescreve config ajustada (idempotente)", async () => {
  await db.exec("BEGIN");
  try {
    await db.q(`UPDATE public.app_config SET value = 'aplicar' WHERE key = 'bots_auth_mode'`);
    await db.exec(MIG);
    eq((await db.q(`SELECT value FROM public.app_config WHERE key = 'bots_auth_mode'`))[0].value, "aplicar", "sobrescreveu");
    eq((await db.q(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS p`, [FN]))[0].p, true, "grant");
  } finally {
    await db.exec("ROLLBACK");
  }
});

await t("8. ROLLBACK da V3: some a função e as chaves; ai_quota (V2) intacta", async () => {
  await db.exec("BEGIN");
  try {
    const antes = (await db.q(`SELECT count(*)::int AS n FROM public.ai_quota`))[0].n;
    await db.exec(ROLLBACK);
    for (const f of [FN, "public.judge_lease_take(uuid,integer,integer)", "public.judge_lease_release(uuid,integer)"])
      eq((await db.q(`SELECT to_regprocedure($1) AS f`, [f]))[0].f, null, f);
    eq((await db.q(`SELECT count(*)::int AS n FROM public.app_config WHERE key IN ('bots_auth_mode','bots_ai_round_limit')`))[0].n, 0, "chaves");
    eq((await db.q(`SELECT count(*)::int AS n FROM public.ai_quota`))[0].n, antes, "ai_quota");
  } finally {
    await db.exec("ROLLBACK");
  }
  eq((await db.q(`SELECT to_regprocedure($1)::text AS f`, [FN]))[0].f, "bots_quota_take(uuid,integer)", "desfeito");
});

// ---------------------------------------------------------------- juiz
const LT = "public.judge_lease_take(uuid,integer,integer)";
const LR = "public.judge_lease_release(uuid,integer)";
const leaseTake = async (room, round, q = db.q) => (await q(`SELECT public.judge_lease_take($1, $2) AS ok`, [room, round]))[0].ok;
const leaseRelease = async (room, round) => db.q(`SELECT public.judge_lease_release($1, $2)`, [room, round]);

await t("9. reserva do juiz: só service_role executa (take/release)", async () => {
  for (const f of [LT, LR]) {
    for (const r of ["anon", "authenticated"])
      eq((await db.q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS p`, [r, f]))[0].p, false, `${r} ${f}`);
    eq((await db.q(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS p`, [f]))[0].p, true, f);
  }
});

await t("10. reserva: 1ª toma, 2ª recusa, solta → toma de novo; rodada/sala diferentes são independentes", async () => {
  const sala = novaSala();
  eq(await leaseTake(sala, 1), true, "1ª");
  eq(await leaseTake(sala, 1), false, "2ª (em andamento)");
  eq(await leaseTake(sala, 2), true, "outra rodada");
  eq(await leaseTake(novaSala(), 1), true, "outra sala");
  await leaseRelease(sala, 1);
  eq(await leaseTake(sala, 1), true, "depois de soltar");
});

await t("11. reserva vencida (edge caiu sem soltar) libera sozinha depois do prazo", async () => {
  const sala = novaSala();
  eq(await leaseTake(sala, 1), true, "1ª");
  await db.q(`UPDATE public.ai_quota SET window_start = now() - interval '31 seconds' WHERE key = $1`, [`judge_lease:${sala}:1`]);
  eq(await leaseTake(sala, 1), true, "vencida → toma");
  eq(await leaseTake(sala, 1), false, "nova reserva vale");
  eq((await db.q(`SELECT count(*)::int AS n FROM public.ai_quota WHERE key = $1`, [`judge_lease:${sala}:1`]))[0].n, 1, "uma linha só");
});

await t("12. concorrência: N avaliações simultâneas da mesma rodada → exatamente 1 reserva", async () => {
  const sala = novaSala();
  const N = 10;
  let res;
  if (modePg) {
    const conns = await Promise.all(Array.from({ length: N }, () => db.conn()));
    try {
      res = await Promise.all(
        conns.map(async (c) => {
          await c.query("BEGIN");
          await c.query("SET LOCAL ROLE service_role");
          const v = (await c.query(`SELECT public.judge_lease_take($1, 1) AS ok`, [sala])).rows[0].ok;
          await c.query("COMMIT");
          return v;
        }),
      );
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  } else {
    res = [];
    for (let i = 0; i < N; i++) res.push(await leaseTake(sala, 1));
  }
  eq(res.filter(Boolean).length, 1, `reservas: ${JSON.stringify(res)}`);
});

await t("13. sala/rodada nulas: erro 22023", async () => {
  let code = null;
  try {
    await leaseTake(null, 1);
  } catch (e) {
    code = e.code ?? null;
  }
  eq(code, "22023");
});

// limpeza (o banco da CI segue para as outras suítes)
await db.q(`DELETE FROM public.ai_quota WHERE key LIKE ANY($1)`, [salas.flatMap((s) => [`bots_round:${s}:%`, `judge_lease:${s}:%`])]);
await db.close();
console.log(fail ? `\n${fail}/${pass + fail} FALHAS` : `\nV3 COTA SQL OK — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
