// Valida a calibração do juiz com os DOIS casos do playtest 2026-07-21:
// 1) verdade "desse modo, assim sendo" vs "por conseguinte"          -> APROVA
// 2) verdade "conversa fiada, papo furado" vs "conversa informal, inutil" -> APROVA
// 3) controle negativo: "tipo de peixe de agua doce"                 -> REJEITA
import pg from "pg";
const { SUPA_URL, ANON, DB_URL } = process.env;
const ssl = /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: DB_URL, ssl });
await c.connect();

let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

const cases = [
  { truth: "desse modo, assim sendo", cand: "por conseguinte", expect: true, name: "conectivo sinônimo" },
  { truth: "conversa fiada, papo furado", cand: "conversa informal, inutil", expect: true, name: "mesma ideia, adjetivos diferentes" },
  { truth: "desse modo, assim sendo", cand: "tipo de peixe de agua doce", expect: false, name: "controle negativo" },
];

for (const [i, cs] of cases.entries()) {
  const code = `990${4 + i}`;
  await c.query(`DELETE FROM public.rooms WHERE code = $1`, [code]);
  const { rows: [w] } = await c.query(`SELECT id FROM public.words LIMIT 1 OFFSET ${i}`);
  const { rows: [room] } = await c.query(
    `INSERT INTO public.rooms (code, host_id, status, current_round, current_word_id)
     VALUES ($1,'judge_a','reveal',1,$2) RETURNING id`, [code, w.id]);
  await c.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot)
     VALUES ('judge_a_${i}', $1, 'J', '🦊', '#f00', false)
     ON CONFLICT (id) DO UPDATE SET room_id = EXCLUDED.room_id`, [room.id]);
  await c.query(
    `INSERT INTO public.rounds (room_id, round, coordinator_id, word_id) VALUES ($1, 1, 'judge_a_${i}', $2)`,
    [room.id, w.id]);
  await c.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
     VALUES ($1, 1, '__truth__', $2, true)`, [room.id, cs.truth]);
  const { rows: [cand] } = await c.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
     VALUES ($1, 1, 'judge_a_${i}', $2, false) RETURNING id`, [room.id, cs.cand]);

  const r = await fetch(`${SUPA_URL}/functions/v1/score-similarity`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify({ room_id: room.id, round: 1, candidates: [{ id: cand.id, text: cs.cand }] }),
  });
  const body = await r.json();
  const matched = Array.isArray(body.matches) && body.matches.includes(cand.id);
  check(cs.name, matched === cs.expect, `"${cs.cand}" vs "${cs.truth}" → matched=${matched} ${body.error ?? ""}`);

  await c.query(`DELETE FROM public.rooms WHERE id = $1`, [room.id]);
  await c.query(`DELETE FROM public.players WHERE id = 'judge_a_${i}'`);
}
await c.end();
console.log(fails ? `\n${fails} FALHAS` : "\nJUIZ CALIBRADO OK");
process.exit(fails ? 1 : 0);
