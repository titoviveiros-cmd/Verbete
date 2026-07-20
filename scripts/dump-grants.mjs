// Espelha os GRANTs de tabela/coluna de PRODUÇÃO (estado pós-Fase 1, já com
// os REVOKEs) como statements SQL — vira migration para o Supabase local do
// CI nascer com os mesmos privilégios. Em produção, reaplicar é no-op.
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();

const ROLES = ["anon", "authenticated"];

// Grants de tabela inteira
const { rows: tg } = await c.query(`
  SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee = ANY($1)
   ORDER BY table_name, grantee, privilege_type`, [ROLES]);

// Grants por coluna (inclui os derivados de grants de tabela — filtramos)
const { rows: cg } = await c.query(`
  SELECT grantee, table_name, column_name, privilege_type
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND grantee = ANY($1)
   ORDER BY table_name, grantee, privilege_type, column_name`, [ROLES]);

const tableKey = (g, t, p) => `${g}|${t}|${p}`;
const hasTable = new Set(tg.map((r) => tableKey(r.grantee, r.table_name, r.privilege_type)));

// Agrupa table-grants: table -> grantee -> [privs]
const byTable = new Map();
for (const r of tg) {
  const k = `${r.table_name}|${r.grantee}`;
  if (!byTable.has(k)) byTable.set(k, []);
  byTable.get(k).push(r.privilege_type);
}
console.log("-- Grants de TABELA (produção):");
for (const [k, privs] of byTable) {
  const [table, grantee] = k.split("|");
  console.log(`GRANT ${privs.join(", ")} ON public.${table} TO ${grantee};`);
}

// Column-grants só onde NÃO há table-grant do mesmo privilégio
const colOnly = new Map();
for (const r of cg) {
  if (hasTable.has(tableKey(r.grantee, r.table_name, r.privilege_type))) continue;
  const k = `${r.table_name}|${r.grantee}|${r.privilege_type}`;
  if (!colOnly.has(k)) colOnly.set(k, []);
  colOnly.get(k).push(r.column_name);
}
console.log("\n-- Grants por COLUNA (produção, sem table-grant equivalente):");
for (const [k, cols] of colOnly) {
  const [table, grantee, priv] = k.split("|");
  console.log(`GRANT ${priv} (${cols.join(", ")}) ON public.${table} TO ${grantee};`);
}

// Sequences
const { rows: sq } = await c.query(`
  SELECT grantee, object_name, privilege_type
    FROM information_schema.role_usage_grants
   WHERE object_schema = 'public' AND object_type = 'SEQUENCE' AND grantee = ANY($1)`, [ROLES]);
console.log("\n-- Sequences:");
for (const r of sq) console.log(`GRANT ${r.privilege_type} ON SEQUENCE public.${r.object_name} TO ${r.grantee};`);

await c.end();
