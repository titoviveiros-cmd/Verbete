// Re-julga a rodada 4 da sala 3400 com o def id REAL do Tito ("pobreza").
// Se a IA aprovar, a própria função aplica o +3 retroativo via
// apply_similarity_bonus. Depois confere o banco.
import pg from "pg";
const { SUPA_URL, ANON, DB_URL } = process.env;

const c = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows: [def] } = await c.query(
  `SELECT d.id, d.text FROM public.definitions d
   JOIN public.rooms r ON r.id = d.room_id
   JOIN public.players p ON p.id = d.player_id
   WHERE r.code = '3400' AND d.round = 4 AND p.is_bot = false`);
console.log("def do Tito:", JSON.stringify(def));

const r = await fetch(`${SUPA_URL}/functions/v1/score-similarity`, {
  method: "POST",
  headers: { Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    room_id: "b43e0a71-914e-4fcd-950e-5864038332ed",
    round: 4,
    candidates: [{ id: def.id, text: def.text }],
  }),
});
console.log("julgamento:", r.status, await r.text());

const { rows: after } = await c.query(
  `SELECT p.nickname, p.score, d.near_truth FROM public.definitions d
   JOIN public.players p ON p.id = d.player_id
   WHERE d.id = $1`, [def.id]);
console.log("depois:", JSON.stringify(after));
await c.end();
