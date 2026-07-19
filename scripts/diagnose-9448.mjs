import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows: [room] } = await c.query("SELECT id, current_round FROM public.rooms WHERE code = '9448'");
const { rows: votes } = await c.query(
  "SELECT v.round, v.voter_id, p.nickname, left(d.text,30) AS def, d.is_truth FROM public.votes v LEFT JOIN public.players p ON p.id = v.voter_id JOIN public.definitions d ON d.id = v.definition_id WHERE v.room_id = $1 ORDER BY v.round", [room.id]);
console.log("VOTES:", JSON.stringify(votes));
const { rows: near } = await c.query(
  "SELECT round, left(text,35) t, near_truth FROM public.definitions WHERE room_id = $1 AND is_truth = false ORDER BY round", [room.id]);
console.log("DEFS near_truth:", JSON.stringify(near));
const { rows: resp } = await c.query(
  "SELECT status_code, left(content::text, 120) body FROM net._http_response ORDER BY created DESC LIMIT 5").catch(() => ({ rows: [{ note: "sem acesso a net._http_response" }] }));
console.log("pg_net respostas recentes:", JSON.stringify(resp));
await c.end();
