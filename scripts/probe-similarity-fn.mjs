// Onde vive o pg_trgm e o submit_definition funciona?
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
const { rows: ext } = await c.query(
  `SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname IN ('pg_trgm','unaccent')`);
console.log("extensões:", JSON.stringify(ext));
// sala de teste rápida
await c.query(`DELETE FROM public.rooms WHERE code = '9902'`);
const { rows: [room] } = await c.query(
  `INSERT INTO public.rooms (code, host_id, status, current_round, current_coordinator)
   VALUES ('9902','simtest_a','writing',1,'simtest_c') RETURNING id`);
await c.query(`
  INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot) VALUES
  ('simtest_a', $1, 'A', '🦊', '#f00', false),
  ('simtest_c', $1, 'C', '🐼', '#00f', false)`, [room.id]);
try {
  const { rows } = await c.query(
    `SELECT public.submit_definition($1, 'simtest_a', 'primeira definicao de teste totalmente unica') AS out`, [room.id]);
  console.log("submit 1:", JSON.stringify(rows[0].out));
  const { rows: r2 } = await c.query(
    `SELECT public.submit_definition($1, 'simtest_a', 'primeira definicao de teste quase unica') AS out`, [room.id]);
  console.log("submit 2 (própria, deve substituir):", JSON.stringify(r2[0].out));
} catch (e) {
  console.log("ERRO submit_definition:", e.message);
}
await c.query(`DELETE FROM public.rooms WHERE code = '9902'`);
await c.query(`DELETE FROM public.players WHERE id LIKE 'simtest_%'`);
await c.end();
