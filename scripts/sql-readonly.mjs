// Executa um arquivo .sql numa transação READ ONLY (qualquer escrita falha)
// e imprime as linhas — para dry-runs e conferências em produção sem risco.
// Uso: DB_URL=... node scripts/sql-readonly.mjs <arquivo.sql>
import pg from "pg";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file || !process.env.DB_URL) {
  console.error("uso: DB_URL=... node scripts/sql-readonly.mjs <arquivo.sql>");
  process.exit(2);
}
const db = new pg.Client({
  connectionString: process.env.DB_URL,
  ssl: /supabase\.co/.test(process.env.DB_URL) ? { rejectUnauthorized: false } : false,
});
await db.connect();
try {
  await db.query("BEGIN READ ONLY");
  const res = await db.query(readFileSync(file, "utf8"));
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  console.table(last.rows);
  console.log(`${last.rows.length} linha(s)`);
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}
