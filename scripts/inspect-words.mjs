// Estrutura atual de words: colunas, constraints, contagem por categoria/nível.
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
const { rows: cols } = await c.query(`
  SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns WHERE table_schema='public' AND table_name='words'
   ORDER BY ordinal_position`);
console.log("colunas:", cols.map((r) => `${r.column_name}(${r.data_type}${r.is_nullable === "NO" ? "!" : ""})`).join(", "));
const { rows: cons } = await c.query(`
  SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.words'::regclass`);
console.log("constraints:", JSON.stringify(cons, null, 1));
const { rows: [tot] } = await c.query(`SELECT count(*)::int AS n FROM public.words`);
console.log("total:", tot.n);
const { rows: cats } = await c.query(
  `SELECT category, count(*)::int AS n FROM public.words GROUP BY category ORDER BY n DESC`);
console.log("por categoria:", cats.map((r) => `${r.category}:${r.n}`).join(" "));
const { rows: nivs } = await c.query(
  `SELECT nivel, count(*)::int AS n FROM public.words GROUP BY nivel ORDER BY n DESC`);
console.log("por nível:", nivs.map((r) => `${r.nivel}:${r.n}`).join(" "));
await c.end();
