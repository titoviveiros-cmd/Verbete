// Extrai a definição viva de funções do banco (uso: DB_URL=... FNS=a,b,c node scripts/dump-functions.mjs)
import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
for (const fn of (process.env.FNS ?? "").split(",")) {
  const { rows } = await client.query(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = $1`, [fn.trim()]);
  for (const r of rows) console.log(`\n-- ===== ${fn} =====\n` + r.def);
}
await client.end();
