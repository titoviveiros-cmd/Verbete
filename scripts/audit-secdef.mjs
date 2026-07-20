// Inventário de TODAS as funções SECURITY DEFINER de public: nome, args,
// search_path fixado?, volatilidade, grants (quem pode EXECUTE), e se o corpo
// contém FOR UPDATE / validações de fase. Base da auditoria docs/security-audit.md.
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows } = await c.query(`
  SELECT p.proname AS fn,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosecdef AS secdef,
         p.proconfig AS config,
         p.provolatile AS volatility,
         pg_get_functiondef(p.oid) AS body,
         (SELECT string_agg(DISTINCT grantee::text, ',')
            FROM information_schema.routine_privileges rp
           WHERE rp.routine_schema = 'public' AND rp.routine_name = p.proname
             AND rp.privilege_type = 'EXECUTE') AS grantees
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
   ORDER BY p.proname`);
const summary = rows.map(r => ({
  fn: r.fn,
  args: r.args,
  search_path_fixado: (r.config ?? []).some(x => x.startsWith("search_path")),
  grantees: r.grantees,
  for_update: /FOR UPDATE/i.test(r.body),
  checa_status: /status\s*(=|<>|IN|NOT IN)/i.test(r.body),
  usa_auth_uid: /auth\.uid\(\)/i.test(r.body),
  linhas: r.body.split("\n").length,
}));
console.log(JSON.stringify(summary, null, 1));
console.log("TOTAL:", rows.length);
await c.end();
