// Recoloca a sala 8243 em `scoreboard` (com deadline folgado para o cron
// não avançar durante o teste visual) e imprime host_id + jogadores.
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows: [room] } = await c.query(
  `SELECT id, code, status, host_id, current_round FROM public.rooms WHERE code = '8243'`);
console.log("antes:", JSON.stringify(room));
if (!room) { await c.end(); process.exit(1); }
await c.query(
  `UPDATE public.rooms SET status = 'scoreboard',
     round_phase_ends_at = now() + interval '30 minutes'
   WHERE id = $1`, [room.id]);
const { rows: players } = await c.query(
  `SELECT id, nickname, is_bot, score FROM public.players WHERE room_id = $1 ORDER BY score DESC`, [room.id]);
console.log("host_id:", room.host_id);
console.log("players:", JSON.stringify(players));
await c.end();
