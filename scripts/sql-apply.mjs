// Aplica um arquivo .sql numa transação única — para os rollbacks e a
// manutenção do M1 em produção, sem depender de psql.
// Por padrão é ENSAIO: aplica, confirma que não deu erro e DESFAZ (ROLLBACK).
// Só grava com --commit. Tudo ou nada: se um comando falhar, nada fica.
// lock_timeout curto: se uma partida segurar a tabela, falha em vez de
// enfileirar o jogo inteiro atrás do DDL.
// Uso: DB_URL=... node scripts/sql-apply.mjs <arquivo.sql> [--commit]
import pg from "pg";
import { readFileSync } from "node:fs";

const file = process.argv[2];
const commit = process.argv.includes("--commit");
if (!file || !process.env.DB_URL) {
  console.error("uso: DB_URL=... node scripts/sql-apply.mjs <arquivo.sql> [--commit]");
  process.exit(2);
}
const db = new pg.Client({
  connectionString: process.env.DB_URL,
  ssl: /supabase\.co/.test(process.env.DB_URL) ? { rejectUnauthorized: false } : false,
});
await db.connect();
let ok = false;
try {
  await db.query("BEGIN");
  await db.query("SET LOCAL lock_timeout = '5s'");
  await db.query("SET LOCAL statement_timeout = '120s'");
  const res = await db.query(readFileSync(file, "utf8"));
  const n = Array.isArray(res) ? res.length : 1;
  await db.query(commit ? "COMMIT" : "ROLLBACK");
  ok = true;
  console.log(
    commit
      ? `✅ ${file}: ${n} comando(s) aplicados e GRAVADOS (COMMIT)`
      : `✅ ENSAIO ${file}: ${n} comando(s) aplicaram sem erro e foram DESFEITOS (nada gravado). Para gravar: --commit`,
  );
} catch (e) {
  await db.query("ROLLBACK").catch(() => {});
  console.error(`❌ ${file}: ${e.message} — nada foi gravado`);
} finally {
  await db.end();
}
process.exit(ok ? 0 : 1);
