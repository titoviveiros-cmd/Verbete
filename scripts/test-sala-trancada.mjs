// ECA Digital B4 (11/11/2026) — sala privada por convite, dono tranca,
// partida rápida fechada (20261111140000_sala_trancada_partida_rapida.sql).
// Confere no banco do CI, com sessões simuladas (request.jwt.claims):
//   * sala destrancada: amigo entra pelo código (fluxo de convite intacto);
//   * dono tranca: ninguém novo entra; quem já está reconecta; expulso não
//     volta; bot entra; quem não é dono não tranca;
//   * destrancar reabre;
//   * partida rápida: fechada para sessão do app; abre só com o parâmetro
//     verbete.public_rooms_open = 'on' (decisão do dono do banco);
//   * set_room_locked só para authenticated (nunca anon); funções internas
//     fechadas; rollback limpo.
// Tudo numa transação desfeita no fim. Envs: DB_URL.
import { randomUUID } from "node:crypto";
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
const as = async (uid, sql, p = []) => {
  await db.query("SAVEPOINT a");
  try {
    await db.query(`SET LOCAL request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'`);
    const r = (await db.query(sql, p)).rows[0];
    await db.query("RELEASE SAVEPOINT a");
    return { ok: true, row: r };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT a");
    return { ok: false, error: e.message };
  } finally {
    await db.query(`SET LOCAL request.jwt.claims = ''`).catch(() => {});
  }
};

await db.query("BEGIN");
try {
  const tag = Math.random().toString(36).slice(2, 7);
  const [U1, U2, U3, U4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [P1, P2, P3, P4] = ["h", "a", "b", "q"].map((x) => `st_${x}_${tag}`);
  const room = await row(
    `INSERT INTO public.rooms (code, host_id, status) VALUES ($1, $2, 'lobby') RETURNING id, code, locked`,
    [`ST${tag}`, P1],
  );
  check("sala nova nasce destrancada (padrão: privada por código/link)", room.locked === false);
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id) VALUES ($1, $2, 'Dona', 'x', '#000', $3)`,
    [P1, room.id, U1],
  );
  const join = (uid, pid) =>
    as(uid, `SELECT public.rejoin_room($1, $2, 'Amigo', 'x', '#000') v`, [room.code, pid]);
  const lock = (uid, pid, v) =>
    as(uid, `SELECT public.set_room_locked($1, $2, $3) v`, [room.id, pid, v]);

  const a = await join(U2, P2);
  check("amigo entra pelo código (convite)", a.ok, a.error);

  const notHost = await lock(U2, P2, true);
  check("quem não é dono não tranca", notHost.ok && notHost.row.v.reason === "not_host", JSON.stringify(notHost));

  const l = await lock(U1, P1, true);
  check("dono tranca", l.ok && l.row.v.ok === true, JSON.stringify(l));

  const b = await join(U3, P3);
  check("sala trancada: ninguém novo entra (room_locked)", !b.ok && /room_locked/.test(b.error ?? ""), b.error);

  const back = await join(U2, P2);
  check("sala trancada: quem já está reconecta", back.ok, back.error);

  await db.query(`INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot) VALUES ($1, $2, 'Bot', 'x', '#000', true)`, [`st_bot_${tag}`, room.id]);
  check("sala trancada: bot entra", true);

  await db.query(`UPDATE public.rooms SET status = 'writing' WHERE id = $1`, [room.id]);
  await db.query(`UPDATE public.players SET kicked_at = now() WHERE id = $1`, [P2]);
  const kicked = await join(U2, P2);
  check("sala trancada: expulso não volta", !kicked.ok && /room_locked/.test(kicked.error ?? ""), kicked.error);
  await db.query(`UPDATE public.rooms SET status = 'lobby' WHERE id = $1`, [room.id]);

  const u = await lock(U1, P1, false);
  const c = await join(U3, P3);
  check("destrancar reabre para o convite", u.ok && c.ok, c.error);

  const q = await as(U4, `SELECT id FROM public.join_public_room($1, 'Quem', 'x', '#000')`, [P4]);
  check("partida rápida fechada para sessão do app (public_rooms_closed)", !q.ok && /public_rooms_closed/.test(q.error ?? ""), q.error);
  await db.query(`SET LOCAL verbete.public_rooms_open = 'on'`);
  const q2 = await as(U4, `SELECT id FROM public.join_public_room($1, 'Quem', 'x', '#000')`, [P4]);
  check("partida rápida abre só com verbete.public_rooms_open = 'on'", q2.ok, q2.error);
  await db.query(`SET LOCAL verbete.public_rooms_open = ''`);

  const g = await row(
    `SELECT has_function_privilege('anon', 'public.set_room_locked(uuid,text,boolean)', 'EXECUTE') anon_x,
            has_function_privilege('authenticated', 'public.set_room_locked(uuid,text,boolean)', 'EXECUTE') auth_x,
            has_function_privilege('anon', 'public.players_room_access_guard()', 'EXECUTE')
              OR has_function_privilege('authenticated', 'public.players_room_access_guard()', 'EXECUTE')
              OR has_function_privilege('anon', 'public.public_rooms_open()', 'EXECUTE')
              OR has_function_privilege('authenticated', 'public.public_rooms_open()', 'EXECUTE') internal_x`,
  );
  check("set_room_locked só authenticated; internas fechadas", !g.anon_x && g.auth_x && !g.internal_x, JSON.stringify(g));

  await db.query(readFileSync("supabase/rollback/sala_trancada_partida_rapida.sql", "utf8"));
  const gone = await row(
    `SELECT to_regprocedure('public.set_room_locked(uuid,text,boolean)') f,
            (SELECT count(*)::int FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'locked') c`,
  );
  check("rollback: função e coluna saem", gone.f === null && gone.c === 0, JSON.stringify(gone));
} catch (e) {
  check("suíte rodou até o fim", false, e.message);
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}
console.log(`\n${total - fails}/${total} verificações OK`);
process.exit(fails ? 1 : 0);
