// Sondas pós-deploy do M1 em PRODUÇÃO — rodar só DEPOIS de aplicar as
// migrations e publicar edges/web, com autorização. Nada aqui altera dados:
// leituras de catálogo (privilégios) + chamadas que DEVEM ser recusadas.
// Se alguma recusa falhar, a sonda acusa ANTES de qualquer efeito (as
// tentativas usam ids inexistentes / sala inexistente).
// Envs: SUPA_URL, ANON (chave publicável), DB_URL (postgres), APP_URL,
// EXPECT_BUILD (opcional: SHA do deploy web, confere o meta verbete-build),
// SKIP_WEB=1 (só no CI, que valida esta sonda contra o banco local no M1),
// PROBE_DB=linked|local: lê o catálogo pela CLI do Supabase (`db query`), sem
// DB_URL — para quando a senha do banco não está na máquina (a CLI logada usa
// um papel temporário de login).
import pg from "pg";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpGet } from "./lib/http-doh.mjs";

const { SUPA_URL, ANON, DB_URL, EXPECT_BUILD, SKIP_WEB, PROBE_DB } = process.env;
const APP_URL = process.env.APP_URL ?? "https://jogo.verbete.workers.dev";
let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const rest = async (path, body) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    // só a apikey (chave publicável sb_publishable_…): o gateway trata como anon
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

let db = null;
let q;
if (PROBE_DB === "linked" || PROBE_DB === "local") {
  const dir = mkdtempSync(join(tmpdir(), "probe-m1-"));
  let n = 0;
  q = async (sql) => {
    const file = join(dir, `q${n++}.sql`);
    writeFileSync(file, sql);
    const r = spawnSync(
      process.execPath,
      ["node_modules/supabase/dist/supabase.js", "db", "query", `--${PROBE_DB}`, "--output-format", "json", "-f", file],
      { encoding: "utf8" },
    );
    const out = r.stdout ?? "";
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    let parsed = null;
    try {
      parsed = JSON.parse(json);
    } catch {
      /* cai no erro abaixo */
    }
    if (r.status !== 0 || !Array.isArray(parsed?.rows)) {
      throw new Error(`db query --${PROBE_DB} falhou: ${(out + (r.stderr ?? "")).trim().slice(0, 300)}`);
    }
    return parsed.rows;
  };
} else {
  db = new pg.Client({
    connectionString: DB_URL,
    ssl: /supabase\.(co|com)/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  q = async (sql) => (await db.query(sql)).rows;
}

console.log("— Catálogo (somente leitura)");
const mig = await q(
  `SELECT version FROM supabase_migrations.schema_migrations WHERE version >= '20261003000000' ORDER BY version`,
);
check("5 migrations do M1 aplicadas", mig.length === 5, mig.map((m) => m.version).join(", "));
const svc = await q(`
  SELECT t.tbl, t.priv
    FROM (VALUES ('rooms','SELECT'), ('rounds','SELECT'), ('words','SELECT'), ('room_words','SELECT'),
                 ('definitions','SELECT'), ('ai_served_defs','INSERT'), ('ops_events','INSERT')) AS t(tbl, priv)
   WHERE NOT has_table_privilege('service_role', 'public.' || t.tbl, t.priv)`);
check("chave de serviço (edges) lê/grava o que precisa", svc.length === 0, JSON.stringify(svc));
const writable = await q(`
  SELECT r.role, t.tbl, p.priv
    FROM unnest(ARRAY['anon','authenticated']) r(role)
    CROSS JOIN unnest(ARRAY['players','definitions','votes','rounds','round_extensions','rooms',
                            'room_words','reactions','room_messages','words']) t(tbl)
    CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p(priv)
   WHERE has_table_privilege(r.role, 'public.' || t.tbl, p.priv)`);
check("nenhuma escrita direta para anon/authenticated", writable.length === 0, JSON.stringify(writable).slice(0, 200));
const [col] = await q(
  `SELECT has_column_privilege('anon','public.room_words','meaning','SELECT') AS m,
          has_column_privilege('authenticated','public.room_words','meaning','SELECT') AS a`,
);
check("room_words.meaning ilegível pela API", !col.m && !col.a);
const leaked = await q(`
  SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('apply_similarity_bonus','insert_truth_definition','tick_stalled_rooms',
                       'cleanup_zombie_rooms','ops_health_check','assert_actor_identity','get_app_config')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`);
check("funções internas fechadas", leaked.length === 0, leaked.map((x) => x.proname).join(", "));
const jobs = await q(`SELECT jobname FROM cron.job WHERE jobname IN ('verbete-tick-stalled-rooms','verbete-ops-health')`);
check("cron do motor e da saúde agendados", jobs.length === 2, jobs.map((j) => j.jobname).join(", "));
// idade calculada no banco: independe do formato de data de cada transporte
const [hbTable] = await q(`SELECT to_regclass('public.ops_heartbeat') IS NOT NULL AS ok`);
const [hb] = hbTable?.ok
  ? await q(
      `SELECT extract(epoch FROM now() - max(at))::int AS age_s, max(at)::text AS at
         FROM public.ops_heartbeat WHERE job = 'tick_stalled_rooms'`,
    )
  : [{ age_s: null, at: "tabela ops_heartbeat ausente" }];
check(
  "heartbeat do tick recente (< 3 min)",
  hb?.age_s !== null && hb?.age_s !== undefined && Number(hb.age_s) < 180,
  `${hb?.at} (${hb?.age_s} s atrás)`,
);

if (fails > 0) {
  console.log("\nCatálogo com falha: as tentativas pela API NÃO serão feitas (poderiam gravar algo).");
  await db?.end();
  process.exit(1);
}

console.log("\n— API pública (tentativas que DEVEM ser recusadas)");
const fake = "00000000-0000-0000-0000-000000000000";
let r = await rest("rpc/create_room_with_host", {
  p_host_id: "probe_m1", p_nickname: "probe", p_avatar: "x", p_color: "#000",
});
check("criar sala sem sessão recusado", r.status >= 400 && /session_required/.test(r.text), `HTTP ${r.status}`);
r = await rest("rpc/apply_similarity_bonus", { p_room_id: fake, p_round: 1, p_definition_ids: [] });
check("apply_similarity_bonus recusado", r.status >= 400, `HTTP ${r.status}`);
r = await rest("rpc/insert_truth_definition", { p_room_id: fake, p_round: 1, p_text: "x" });
check("insert_truth_definition recusado", r.status >= 400, `HTTP ${r.status}`);
r = await rest("rounds", { room_id: fake, round: 1 });
check("INSERT direto em rounds recusado", r.status >= 400, `HTTP ${r.status}`);
r = await rest("room_words?select=meaning&limit=1");
check("SELECT room_words.meaning recusado", r.status >= 400, `HTTP ${r.status}`);
r = await rest("rpc/get_client_config", {});
check("get_client_config responde (objeto)", r.status === 200 && r.text.trim().startsWith("{"), r.text.slice(0, 80));

console.log("\n— Edges (lixo na entrada: a versão nova recusa sem tocar o banco nem a IA)");
const edge = async (name) => {
  const r = await fetch(`${SUPA_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "lixo",
  });
  return { status: r.status, text: (await r.text()).slice(0, 120) };
};
let e = await edge("bot-definitions");
check("bot-definitions publicada (versão M1)", e.status === 400 && /word_id required/.test(e.text), `HTTP ${e.status} ${e.text}`);
e = await edge("score-similarity");
check("score-similarity publicada (versão M1)", e.status === 200 && e.text.trim() === '{"matches":[]}', `HTTP ${e.status} ${e.text}`);

if (SKIP_WEB) {
  console.log("\n— Web: pulado (SKIP_WEB)");
} else {
  console.log("\n— Web");
  const og = await httpGet(`${APP_URL}/og-verbete.jpg`, "HEAD");
  check("og:image 200 image/jpeg", og.status === 200 && /image\/jpeg/.test(og.type), `HTTP ${og.status} ${og.type}`);
}
if (EXPECT_BUILD && !SKIP_WEB) {
  const home = await httpGet(`${APP_URL}/`);
  const build = home.body.match(/name="verbete-build" content="([^"]*)"/)?.[1] ?? "";
  check(
    "web servindo o build esperado",
    build !== "" && build.slice(0, 7) === EXPECT_BUILD.slice(0, 7),
    `servindo ${build || "?"}, esperado ${EXPECT_BUILD.slice(0, 7)}`,
  );
}

await db?.end();
console.log(fails ? `\n${fails} FALHA(S)` : "\nPRODUÇÃO M1 OK");
process.exit(fails ? 1 : 0);
