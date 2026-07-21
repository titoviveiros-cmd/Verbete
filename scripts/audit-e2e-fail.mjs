// Salas recentes dos testes E2E (nick "E2E ..."): estado, defs e extensões.
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
const { rows: rooms } = await c.query(`
  SELECT r.id, r.code, r.status, r.current_round, r.created_at
    FROM public.rooms r
   WHERE EXISTS (SELECT 1 FROM public.players p WHERE p.room_id = r.id AND p.nickname LIKE 'E2E %')
     AND r.created_at > now() - interval '30 minutes'
   ORDER BY r.created_at DESC LIMIT 3`);
for (const room of rooms) {
  console.log("\n=== sala", room.code, room.status, "r" + room.current_round, room.created_at);
  const { rows: players } = await c.query(
    `SELECT id, nickname, kicked_at, writing_extensions, score FROM public.players WHERE room_id = $1`, [room.id]);
  console.log("players:", JSON.stringify(players));
  const { rows: defs } = await c.query(
    `SELECT round, player_id, substring(text from 1 for 60) AS text, is_truth FROM public.definitions WHERE room_id = $1 ORDER BY round, created_at`, [room.id]);
  console.log("defs:", JSON.stringify(defs, null, 1));
  const { rows: exts } = await c.query(
    `SELECT player_id, round, attempt, phase FROM public.round_extensions WHERE room_id = $1`, [room.id]);
  console.log("extensões:", JSON.stringify(exts));
}
await c.end();
