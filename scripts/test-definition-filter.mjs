// 2.1.4 — anti-cola no servidor sem asteriscos (sala 5873: "ciceronear" virou
// "***ar"). Confere public.definition_reveals_word com os mesmos casos de
// src/lib/__tests__/text-filter.test.ts e o submit_definition recusando
// "reveals_word" e aceitando texto legítimo e texto já mascarado por cliente
// antigo (compatibilidade com o Android 2.1.3).
// Envs: DB_URL.
import { readFileSync } from "node:fs";
import pg from "pg";

const { DB_URL } = process.env;
const ssl = /supabase\.co/.test(DB_URL ?? "")
  ? { rejectUnauthorized: false }
  : false;
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

const REVEALS = [
  ["pessoa responsável por ciceronear, coordenar", "cicerone"],
  ["é a FAZEDA mesmo", "fazeda"],
  ["f.a.z.e.d.a demais", "fazeda"],
  ["fa-ze-da pura", "fazeda"],
  ["f a z e d a pura", "fazeda"],
  ["fa​zeda pura", "fazeda"],
  ["são as pindaíbas do sertão", "pindaíba"],
  ["um ad hoc qualquer", "ad hoc"],
];
const LEGIT = [
  ["peixe amarelo e grande", "mar"],
  ["pessoa responsavel por guiar visitantes", "guia"],
  ["o ato de liderar outras pessoas", "lider"],
  ["cerimonia de mesuras na corte", "rapapé"],
  ["tecido de ab usado em velas", "ab"],
  ["carroça de madeira", "carro"],
  ["guia de turistas; conduz visitas, explica tudo!", "cicerone"],
];
for (const [t, w] of REVEALS)
  check(
    `revela: ${t}`,
    (await row("SELECT public.definition_reveals_word($1,$2) r", [t, w])).r ===
      true,
  );
for (const [t, w] of LEGIT)
  check(
    `legítimo: ${t}`,
    (await row("SELECT public.definition_reveals_word($1,$2) r", [t, w])).r ===
      false,
  );

// submit_definition numa sala em escrita (transação desfeita no fim)
await db.query("BEGIN");
try {
  const tag = Math.random().toString(36).slice(2, 7);
  const w = await row(
    `INSERT INTO public.words (word, meaning, category, status) VALUES ($1, 'guia de visitantes', 'pessoa', 'published')
     ON CONFLICT (word) DO UPDATE SET word = EXCLUDED.word RETURNING id`,
    [`cicerone`],
  );
  const r = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, current_word_id, current_coordinator, phase_started_at)
     VALUES ($1, $2, 'writing', 1, $3, $4, now()) RETURNING id`,
    [`DF${tag}`, `df_h_${tag}`, w.id, `df_c_${tag}`],
  );
  for (const id of [`df_h_${tag}`, `df_c_${tag}`, `df_p_${tag}`])
    await db.query(
      `INSERT INTO public.players (id, room_id, nickname, avatar, color) VALUES ($1, $2, $1, 'x', '#000')`,
      [id, r.id],
    );
  const submit = async (text) =>
    (
      await row("SELECT public.submit_definition($1, $2, $3) v", [
        r.id,
        `df_p_${tag}`,
        text,
      ])
    ).v;
  const a = await submit("pessoa responsavel por ciceronear turistas");
  check(
    "submit recusa a palavra da rodada (reveals_word)",
    a.ok === false && a.reason === "reveals_word",
    JSON.stringify(a),
  );
  // Compatibilidade: cliente antigo (Android 2.1.3) manda texto já mascarado;
  // segue aceito nesta versão — recusar travaria quem não atualizou.
  const b = await submit("pessoa responsavel por ***ar, coordenar");
  check("submit aceita texto mascarado de cliente antigo (compatibilidade 2.1.3)", b.ok === true, JSON.stringify(b));
  const c = await submit("guia de turistas que conduz visitas");
  check("submit aceita texto legítimo", c.ok === true, JSON.stringify(c));
  const n = await row(
    "SELECT count(*)::int n FROM public.definitions WHERE room_id = $1",
    [r.id],
  );
  check("recusada não grava; a última aceita substitui a anterior (1 por jogador)", n.n === 1, `gravadas=${n.n}`);
  const open = await row(
    `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public' AND p.proname IN ('definition_reveals_word', 'definition_reveal_tokens')
        AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
  );
  check(
    "funções internas fechadas para anon/authenticated",
    open.n === 0,
    `${open.n} abertas`,
  );
  // Rollback (dentro da transação desfeita): volta a aceitar e some a regra.
  await db.query(
    readFileSync("supabase/rollback/definition_reveals_word.sql", "utf8"),
  );
  const rb = await submit("pessoa responsavel por ciceronear turistas");
  const gone = await row(
    `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public' AND p.proname IN ('definition_reveals_word', 'definition_reveal_tokens')`,
  );
  check(
    "rollback: submit volta ao corpo anterior e as funções novas saem",
    rb.ok === true && gone.n === 0,
    `${JSON.stringify(rb)} funções=${gone.n}`,
  );
} catch (e) {
  check("suíte rodou até o fim", false, e.message);
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}
console.log(`\n${total - fails}/${total} verificações OK`);
process.exit(fails ? 1 : 0);
