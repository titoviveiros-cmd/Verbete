// Grava chaves na tabela app_config (uso: DB_URL=... KEY=... VALUE=... node scripts/set-config.mjs)
import pg from "pg";

const { DB_URL, KEY, VALUE } = process.env;
if (!DB_URL || !KEY || !VALUE) {
  console.error("Faltam env vars DB_URL, KEY, VALUE");
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(
  `INSERT INTO public.app_config(key, value) VALUES ($1, $2)
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  [KEY, VALUE],
);
const r = await client.query("SELECT key FROM public.app_config ORDER BY key");
console.log("config keys:", r.rows.map((x) => x.key).join(", "));
await client.end();
