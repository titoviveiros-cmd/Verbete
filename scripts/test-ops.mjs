// Smoke da observabilidade (Fase 8): ingestão anônima com rate-limit,
// whitelist de kinds, tabela invisível p/ anon, resumo exige admin.
// Envs: SUPA_URL, ANON, DB_URL.
import pg from "pg";
const { SUPA_URL, ANON, DB_URL } = process.env;

const db = new pg.Client({
  connectionString: DB_URL,
  ssl: /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false,
});
await db.connect();
let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

const rpc = async (fn, body) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

const SESSION = "opstest_" + Math.floor(Math.random() * 1e9).toString(36);

// 1) ingestão anônima funciona
const r1 = await rpc("log_ops_event", {
  p_kind: "client_error",
  p_payload: { message: "smoke test", stack: "at smoke" },
  p_session_key: SESSION,
  p_build: "smoke",
});
check("ingestão anônima aceita (2xx)", r1.status < 300, `HTTP ${r1.status}`);
const { rows: got } = await db.query(
  `SELECT kind, payload->>'message' AS msg, build FROM public.ops_events WHERE session_key = $1`,
  [SESSION],
);
check(
  "evento gravado com payload",
  got.length === 1 && got[0].msg === "smoke test" && got[0].build === "smoke",
  JSON.stringify(got[0] ?? null),
);

// 2) kind fora da whitelist é ignorado
await rpc("log_ops_event", { p_kind: "hacker_kind", p_session_key: SESSION });
const { rows: c2 } = await db.query(
  `SELECT count(*)::int AS n FROM public.ops_events WHERE session_key = $1`,
  [SESSION],
);
check("kind fora da whitelist ignorado", c2[0].n === 1, `n=${c2[0].n}`);

// 3) rate-limit: 30 eventos/5min por sessão
for (let i = 0; i < 35; i++) {
  await rpc("log_ops_event", {
    p_kind: "reconnect",
    p_payload: { i },
    p_session_key: SESSION,
  });
}
const { rows: c3 } = await db.query(
  `SELECT count(*)::int AS n FROM public.ops_events WHERE session_key = $1`,
  [SESSION],
);
check("rate-limit corta em 30/5min", c3[0].n === 30, `n=${c3[0].n}`);

// 4) tabela invisível para anon via REST
const r4 = await fetch(`${SUPA_URL}/rest/v1/ops_events?select=*&limit=1`, {
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
});
check("SELECT anon bloqueado", r4.status === 401 || r4.status === 403 || r4.status === 404, `HTTP ${r4.status}`);

// 5) resumo exige admin (anon sem sessão → not_authorized)
const r5 = await rpc("admin_ops_summary", { p_hours: 24 });
check(
  "admin_ops_summary bloqueado sem admin",
  r5.status >= 400 || /not_authorized/.test(r5.text),
  `HTTP ${r5.status}`,
);

// limpeza
await db.query(`DELETE FROM public.ops_events WHERE session_key = $1`, [SESSION]);
await db.end();
console.log(fails === 0 ? "\nOPS OK" : `\n${fails} FALHAS`);
process.exit(fails === 0 ? 0 : 1);
