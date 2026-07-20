// Auditoria do bônus de similaridade (uso: DB_URL=... CODE=1234 ROUND=4)
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows: [room] } = await c.query("SELECT id FROM public.rooms WHERE code = $1", [process.env.CODE]);
const { rows: defs } = await c.query(
  `SELECT d.round, p.nickname, d.is_truth, d.near_truth, d.text FROM public.definitions d
   LEFT JOIN public.players p ON p.id = d.player_id
   WHERE d.room_id = $1 AND d.round = $2 ORDER BY d.letter`, [room.id, process.env.ROUND]);
console.log("DEFINICOES DA RODADA:", JSON.stringify(defs, null, 1));
const { rows: resp } = await c.query(
  "SELECT id, status_code, left(content::text, 200) body, error_msg FROM net._http_response ORDER BY id DESC LIMIT 8");
console.log("pg_net (ultimas 8):", JSON.stringify(resp, null, 1));
await c.end();
