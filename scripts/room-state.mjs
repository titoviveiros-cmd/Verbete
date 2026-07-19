// Estado de uma sala (uso: DB_URL=... CODE=1234 node scripts/room-state.mjs)
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const r = await client.query(
  "SELECT code, status, win_condition, win_target, nivel, visibility, current_round, current_coordinator, round_phase_ends_at FROM public.rooms WHERE code = $1",
  [process.env.CODE],
);
console.log(JSON.stringify(r.rows, null, 1));
const p = await client.query(
  "SELECT p.id, p.nickname, p.is_bot, p.score FROM public.players p JOIN public.rooms ro ON ro.id = p.room_id WHERE ro.code = $1 ORDER BY p.joined_at",
  [process.env.CODE],
);
console.log(JSON.stringify(p.rows, null, 1));
await client.end();
