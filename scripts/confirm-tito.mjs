// Confirma o e-mail do Tito direto no banco (o link de confirmação apontava
// para localhost:3000 — Site URL padrão) e concede role admin.
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
const email = "titoviveiros@gmail.com";
const { rows } = await c.query(
  `UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, now())
    WHERE email = $1 RETURNING id, email_confirmed_at`, [email]);
if (rows.length === 0) {
  console.log("usuário não encontrado — o cadastro chegou a ser criado?");
} else {
  console.log(`confirmado: ${email} em ${rows[0].email_confirmed_at}`);
  await c.query(
    `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')
     ON CONFLICT DO NOTHING`, [rows[0].id]);
  console.log("role admin concedida ✅");
}
await c.end();
