// ECA Digital (11/11/2026) — denúncia com decisão fundamentada e recurso
// (20261111130000_denuncia_retorno_recurso.sql). Confere no banco do CI:
//   * reports aceita action/decision_reason/review_kind válidos e recusa os
//     inválidos (CHECK); linhas antigas seguem válidas (colunas nulas);
//   * moderation_appeals: 1 recurso por denúncia; texto 1–1000; status válido;
//     some junto com a denúncia (CASCADE);
//   * banned_players.report_id liga o ban à denúncia (SET NULL no expurgo);
//   * anon/authenticated NÃO leem nem gravam moderation_appeals;
//   * rollback limpo.
// Tudo numa transação desfeita no fim. Envs: DB_URL.
import { readFileSync } from "node:fs";
import pg from "pg";

const { DB_URL } = process.env;
const ssl = /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const db = new pg.Client({ connectionString: DB_URL, ssl });
await db.connect();
let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const row = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const fails_ = async (sql, p = []) => {
  await db.query("SAVEPOINT f");
  try {
    await db.query(sql, p);
    await db.query("RELEASE SAVEPOINT f");
    return null;
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT f");
    return e.message;
  }
};

await db.query("BEGIN");
try {
  const rep = "00000000-0000-4000-8000-00000000d001";
  const off = "00000000-0000-4000-8000-00000000d002";
  const r = await row(
    `INSERT INTO public.reports (definition_text, offender_player_id, offender_user_id, reporter_user_id, reason)
     VALUES ('texto', 'p_off', $1, $2, 'harassment') RETURNING id, action, decision_reason, review_kind`,
    [off, rep],
  );
  check("denúncia nova: action/decision_reason nulos, review_kind = human", r.action === null && r.decision_reason === null && r.review_kind === "human", JSON.stringify(r));

  await db.query(
    `UPDATE public.reports SET status = 'resolved', action = 'remove_content', decision_reason = 'dados_pessoais', resolved_at = now() WHERE id = $1`,
    [r.id],
  );
  check("decisão válida grava", true);
  check(
    "action inválida é recusada",
    !!(await fails_(`UPDATE public.reports SET action = 'apagar' WHERE id = $1`, [r.id])),
  );
  check(
    "decision_reason inválido é recusado",
    !!(await fails_(`UPDATE public.reports SET decision_reason = 'qualquer' WHERE id = $1`, [r.id])),
  );
  check(
    "review_kind inválido é recusado",
    !!(await fails_(`UPDATE public.reports SET review_kind = 'ia' WHERE id = $1`, [r.id])),
  );

  await db.query(
    `INSERT INTO public.moderation_appeals (report_id, user_id, text) VALUES ($1, $2, 'não fui eu')`,
    [r.id, off],
  );
  const dup = await fails_(
    `INSERT INTO public.moderation_appeals (report_id, user_id, text) VALUES ($1, $2, 'de novo')`,
    [r.id, off],
  );
  check("1 recurso por denúncia (unique)", /duplicate key|unique/i.test(dup ?? ""), dup ?? "aceitou");
  check(
    "texto vazio recusado",
    !!(await fails_(
      `INSERT INTO public.moderation_appeals (report_id, user_id, text) VALUES ($1, $2, '')`,
      [r.id, off],
    )),
  );
  check(
    "status inválido recusado",
    !!(await fails_(`UPDATE public.moderation_appeals SET status = 'talvez' WHERE report_id = $1`, [r.id])),
  );

  const ban = await row(
    `INSERT INTO public.banned_players (player_id, banned_by, report_id) VALUES ('p_off', $1, $2) RETURNING id`,
    [rep, r.id],
  );
  await db.query(`DELETE FROM public.reports WHERE id = $1`, [r.id]);
  const left = await row(`SELECT count(*)::int n FROM public.moderation_appeals WHERE report_id = $1`, [r.id]);
  const b = await row(`SELECT report_id FROM public.banned_players WHERE id = $1`, [ban.id]);
  check("expurgo da denúncia leva o recurso (CASCADE) e solta o ban (SET NULL)", left.n === 0 && b.report_id === null, `recursos=${left.n} ban.report_id=${b.report_id}`);

  const priv = await row(
    `SELECT has_table_privilege('anon', 'public.moderation_appeals', 'SELECT') a_sel,
            has_table_privilege('anon', 'public.moderation_appeals', 'INSERT') a_ins,
            has_table_privilege('authenticated', 'public.moderation_appeals', 'SELECT') u_sel,
            has_table_privilege('authenticated', 'public.moderation_appeals', 'INSERT') u_ins,
            (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.moderation_appeals'::regclass) rls`,
  );
  check(
    "moderation_appeals fechada para o cliente (sem grant, RLS ligada)",
    !priv.a_sel && !priv.a_ins && !priv.u_sel && !priv.u_ins && priv.rls,
    JSON.stringify(priv),
  );

  await db.query(readFileSync("supabase/rollback/denuncia_retorno_recurso.sql", "utf8"));
  const gone = await row(
    `SELECT to_regclass('public.moderation_appeals') t,
            (SELECT count(*)::int FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'reports'
                AND column_name IN ('action', 'decision_reason', 'review_kind')) c`,
  );
  check("rollback: tabela e colunas saem", gone.t === null && gone.c === 0, JSON.stringify(gone));
} catch (e) {
  check("suíte rodou até o fim", false, e.message);
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}
console.log(`\n${total - fails}/${total} verificações OK`);
process.exit(fails ? 1 : 0);
