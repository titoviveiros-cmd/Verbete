// B6 — ranking opt-in (ECA Digital, 11/11/2026; migration
// 20261111154500_ranking_opt_in + supabase/rollback/ranking_opt_in.sql).
// Prova no banco REAL do CI (Supabase local, todas as migrations):
//   * padrão desligado; quem não optou NÃO aparece (Top 50, Ranking de hoje)
//     nem tem o apelido legível por outra sessão (leitura direta de profiles);
//   * quem optou aparece; desligar tira na hora; ninguém liga pelo outro;
//   * a própria linha continua visível ao dono;
//   * as chamadas do APK vc8 seguem válidas (mesmas assinaturas e colunas);
//   * o rollback volta ao comportamento antigo.
// Tudo numa transação desfeita no fim (o banco do CI segue igual).
// Envs: DB_URL (só host local).
import pg from "pg";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const DB_URL = process.env.DB_URL ?? process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("✖ DB_URL ausente: esta suíte só passa com um Postgres real (Supabase local do CI).");
  process.exit(1);
}
const host = new URL(DB_URL).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  console.error(`✖ recusado: DB_URL aponta para "${host}". Esta suíte só roda em banco LOCAL.`);
  process.exit(1);
}

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const q = async (sql, p = []) => (await db.query(sql, p)).rows;

/** Roda como o PostgREST: papel + claims da sessão (uid null = anon). */
async function as(uid, sql, params = []) {
  await db.query("SAVEPOINT s");
  try {
    await db.query(`SET LOCAL ROLE ${uid ? "authenticated" : "anon"}`);
    await db.query(
      `SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
      [uid ?? "", uid ? JSON.stringify({ sub: uid, role: "authenticated" }) : ""],
    );
    const r = await db.query(sql, params);
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT s");
    return { ok: true, rows: r.rows, rowCount: r.rowCount };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT s");
    return { ok: false, rows: [], rowCount: 0, err: e.message };
  }
}
const ids = (r) => new Set(r.rows.map((x) => x.user_id));
const TOP = `SELECT * FROM public.get_ranking_top(200)`;
const HOJE = `SELECT * FROM public.get_daily_leaderboard(100, 'juiz')`;

await db.query("BEGIN");
try {
  const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];
  const tag = A.slice(0, 6);
  for (const u of [A, B, C]) await q(`INSERT INTO auth.users (id, is_anonymous) VALUES ($1, false)`, [u]);
  // perfis e estatísticas nascem pelo gatilho handle_new_user; upsert por garantia
  for (const [u, nome, score] of [[A, `RkA_${tag}`, 2000000000], [B, `RkB_${tag}`, 1999999999], [C, `RkC_${tag}`, 0]]) {
    await q(`INSERT INTO public.profiles (user_id, display_name) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name`, [u, nome]);
    await q(`INSERT INTO public.user_stats (user_id, total_score) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET total_score = EXCLUDED.total_score`, [u, score]);
  }

  console.log("— Padrão desligado");
  const col = (await q(`SELECT is_nullable, column_default FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'ranking_opt_in'`))[0];
  check("coluna ranking_opt_in NOT NULL DEFAULT false", col?.is_nullable === "NO" && /false/.test(col?.column_default ?? ""), JSON.stringify(col));
  const padrao = await q(`SELECT bool_or(ranking_opt_in) AS algum FROM public.profiles WHERE user_id = ANY($1::uuid[])`, [[A, B, C]]);
  check("conta nova nasce fora do ranking", padrao[0].algum === false);

  // A ativa pela própria sessão (política "self update")
  let r = await as(A, `UPDATE public.profiles SET ranking_opt_in = true WHERE user_id = $1`, [A]);
  check("o titular ativa a própria escolha", r.ok && r.rowCount === 1, r.err);

  console.log("— Top 50 (get_ranking_top)");
  r = await as(null, TOP);
  check("anon: quem optou aparece", r.ok && ids(r).has(A), r.err);
  check("anon: quem NÃO optou não aparece", r.ok && !ids(r).has(B));
  r = await as(C, TOP);
  check("outra conta: só quem optou", r.ok && ids(r).has(A) && !ids(r).has(B), r.err);
  check("nenhuma linha traz o apelido de quem não optou", r.ok && !r.rows.some((x) => x.display_name === `RkB_${tag}`));
  r = await as(B, TOP);
  check("o dono vê a própria linha mesmo desligado", r.ok && ids(r).has(B) && ids(r).has(A), r.err);

  console.log("— Leitura direta de profiles (APK vc8 e PostgREST)");
  r = await as(C, `SELECT user_id, display_name FROM public.profiles WHERE user_id = ANY($1::uuid[])`, [[A, B]]);
  check("outra conta lê o perfil de quem optou e NÃO o de quem não optou", r.ok && ids(r).has(A) && !ids(r).has(B), r.err);
  r = await as(C, `SELECT display_name FROM public.profiles WHERE user_id = $1`, [C]);
  check("o próprio perfil continua legível", r.ok && r.rows.length === 1, r.err);
  r = await as(null, `SELECT user_id FROM public.profiles WHERE user_id = ANY($1::uuid[])`, [[A, B, C]]);
  check("anon não lê perfil nenhum", r.rows.length === 0, r.err);
  r = await as(C, `UPDATE public.profiles SET ranking_opt_in = true WHERE user_id = $1`, [B]);
  check("ninguém ativa pelo outro", r.rowCount === 0, r.err);

  console.log("— Ranking de hoje (get_daily_leaderboard)");
  for (const [u, s] of [[A, 900], [B, 950]])
    await q(`INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, score, time_seconds, is_correct, mode)
             VALUES ($1, date_trunc('hour', now())::date, date_trunc('hour', now()), 'x', $2, 5, true, 'juiz')`, [u, s]);
  r = await as(C, HOJE);
  check("placar do dia: só quem optou", r.ok && ids(r).has(A) && !ids(r).has(B), r.err);
  r = await as(B, HOJE);
  check("placar do dia: o dono vê a própria linha", r.ok && ids(r).has(B), r.err);

  console.log("— Desligar a qualquer momento");
  await as(B, `UPDATE public.profiles SET ranking_opt_in = true WHERE user_id = $1`, [B]);
  r = await as(C, TOP);
  check("B ativa → aparece", r.ok && ids(r).has(B), r.err);
  await as(B, `UPDATE public.profiles SET ranking_opt_in = false WHERE user_id = $1`, [B]);
  r = await as(C, TOP);
  check("B desativa → some na hora", r.ok && !ids(r).has(B), r.err);
  r = await as(C, HOJE);
  check("B desativa → some do placar do dia", r.ok && !ids(r).has(B), r.err);

  console.log("— Compatibilidade com o APK vc8 (2.1.4)");
  r = await as(null, `SELECT * FROM public.get_ranking_top(50)`);
  const cols = r.rows[0] ? Object.keys(r.rows[0]).sort().join(",") : "";
  check(
    "vc8: get_ranking_top(p_limit) com as MESMAS colunas",
    r.ok && cols === "avatar,best_match_score,color,display_name,games_played,games_won,total_score,user_id",
    r.err ?? cols,
  );
  r = await as(C, `SELECT * FROM public.get_daily_leaderboard(20)`);
  check("vc8: get_daily_leaderboard(p_limit) segue válido", r.ok, r.err);
  const grants = (await q(`SELECT has_function_privilege('anon', 'public.get_ranking_top(integer)', 'EXECUTE') AS top_anon,
                                  has_function_privilege('anon', 'public.get_daily_leaderboard(integer,text)', 'EXECUTE') AS dia_anon`))[0];
  check("grants inalterados (Top 50 anon sim; placar do dia anon não)", grants.top_anon === true && grants.dia_anon === false, JSON.stringify(grants));

  console.log("— Rollback (supabase/rollback/ranking_opt_in.sql)");
  await db.query("SAVEPOINT rb");
  try {
    await db.query(readFileSync("supabase/rollback/ranking_opt_in.sql", "utf8"));
    check("aplica sem erro", true);
    r = await as(C, TOP);
    check("Top 50 volta a listar todos os que pontuaram", r.ok && ids(r).has(A) && ids(r).has(B), r.err);
    r = await as(C, `SELECT user_id FROM public.profiles WHERE user_id = ANY($1::uuid[])`, [[A, B]]);
    check("leitura de profiles volta a ser de todos (autenticados)", r.ok && ids(r).has(B), r.err);
    const gone = (await q(`SELECT count(*)::int AS n FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'ranking_opt_in'`))[0].n;
    check("coluna removida", gone === 0);
  } catch (e) {
    check("aplica sem erro", false, e.message);
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT rb");
  }
} finally {
  await db.query("ROLLBACK");
}

const after = (await q(`SELECT count(*)::int AS n FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'ranking_opt_in'`))[0].n;
check("banco do CI segue com a migration após a suíte (transação desfeita)", after === 1);
await db.end();
console.log(fails ? `\n${fails}/${total} FALHAS` : `\nRANKING OPT-IN OK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
