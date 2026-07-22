// Chama submit_daily_attempt_scored direto (como o Worker faz) para expor o erro.
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
const { rows: [u] } = await c.query(
  `SELECT id FROM auth.users WHERE email = 'e2e-daily@verbete.test'`);
console.log("user:", u?.id);
try {
  const { rows } = await c.query(
    `SELECT public.submit_daily_attempt_scored($1, 'lamina pequena e afiada', 10, 85) AS out`,
    [u.id]);
  console.log("ok:", JSON.stringify(rows[0].out).slice(0, 300));
} catch (e) {
  console.log("ERRO:", e.message);
  console.log("detail:", e.detail ?? "", "| hint:", e.hint ?? "", "| where:", (e.where ?? "").slice(0, 200));
}
await c.end();
