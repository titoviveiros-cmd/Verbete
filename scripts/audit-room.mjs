// Auditoria de consistência de pontos (uso: DB_URL=... CODE=1234)
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const code = process.env.CODE;
const { rows: [room] } = await c.query("SELECT id, status, current_round FROM public.rooms WHERE code = $1", [code]);
console.log("room:", JSON.stringify(room));
const { rows: words } = await c.query(
  `SELECT ro.round, COALESCE(w.word, '?') AS word FROM public.rounds ro
   LEFT JOIN public.words w ON w.id = ro.word_id WHERE ro.room_id = $1 ORDER BY ro.round`, [room.id]);
console.log("palavras:", JSON.stringify(words));
const { rows: humanVotes } = await c.query(
  `SELECT v.round, p.nickname, d.is_truth, left(d.text,30) t FROM public.votes v
   JOIN public.players p ON p.id = v.voter_id
   JOIN public.definitions d ON d.id = v.definition_id
   WHERE v.room_id = $1 AND p.is_bot = false ORDER BY v.round`, [room.id]);
console.log("votos humanos:", JSON.stringify(humanVotes));
const { rows: scores } = await c.query(
  "SELECT nickname, score FROM public.players WHERE room_id = $1 ORDER BY score DESC", [room.id]);
console.log("scores:", JSON.stringify(scores));
await c.end();
