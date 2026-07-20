// Auditoria da sala 7850: fases, votos com timestamps, e o voto do Tito.
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
const { rows: [room] } = await c.query(
  `SELECT id, status, current_round, round_phase_ends_at, phase_started_at
     FROM public.rooms WHERE code = '7850'`);
console.log("sala:", JSON.stringify(room));
if (!room) { await c.end(); process.exit(0); }
const { rows: players } = await c.query(
  `SELECT id, nickname, is_bot, score, voting_extensions FROM public.players WHERE room_id = $1`, [room.id]);
console.log("jogadores:", JSON.stringify(players, null, 1));
const cols = await c.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='votes'`);
console.log("colunas votes:", cols.rows.map((r) => r.column_name).join(","));
const { rows: votes } = await c.query(
  `SELECT v.round, p.nickname AS voter, p.is_bot, v.created_at,
          CASE WHEN d.player_id = '__truth__' THEN 'VERDADE' ELSE d.player_id END AS votou_em
     FROM public.votes v
     JOIN public.players p ON p.id = v.voter_id
     JOIN public.definitions d ON d.id = v.definition_id
    WHERE v.room_id = $1 ORDER BY v.round, v.created_at`, [room.id]);
console.log("votos:", JSON.stringify(votes, null, 1));
const { rows: rounds } = await c.query(
  `SELECT round, coordinator_id, scored_at FROM public.rounds WHERE room_id = $1 ORDER BY round`, [room.id]);
console.log("rodadas:", JSON.stringify(rounds, null, 1));
await c.end();
