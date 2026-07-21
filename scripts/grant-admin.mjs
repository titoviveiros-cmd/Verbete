// Concede role admin ao usuário do e-mail (se existir em auth.users).
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
const email = process.env.ADMIN_EMAIL ?? "titoviveiros@gmail.com";
const { rows } = await c.query(
  `SELECT id, email, created_at, is_anonymous FROM auth.users WHERE email = $1`, [email]);
if (rows.length === 0) {
  console.log(`nenhum usuário com ${email} — ele precisa logar uma vez em /login`);
} else {
  const uid = rows[0].id;
  await c.query(
    `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')
     ON CONFLICT DO NOTHING`, [uid]);
  console.log(`admin concedido a ${email} (${uid})`);
}
await c.end();
