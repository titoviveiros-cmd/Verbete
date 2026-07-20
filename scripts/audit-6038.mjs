// Auditoria da sala 6038: estado, votos por rodada, e se o placar bate com
// a regra congelada (+3 verdade, +1 por voto no blefe, +2 coordenador).
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
const { rows: [room] } = await c.query(
  `SELECT id, status, current_round FROM public.rooms WHERE code = '6038'`);
console.log("sala:", JSON.stringify(room));
if (!room) { await c.end(); process.exit(0); }
const { rows: players } = await c.query(
  `SELECT id, nickname, is_bot, score FROM public.players WHERE room_id = $1 ORDER BY score DESC`, [room.id]);
console.log("jogadores:", JSON.stringify(players, null, 1));
const { rows: votes } = await c.query(
  `SELECT v.round, p.nickname AS voter, d.player_id AS def_de
     FROM public.votes v
     JOIN public.players p ON p.id = v.voter_id
     JOIN public.definitions d ON d.id = v.definition_id
    WHERE v.room_id = $1 ORDER BY v.round, p.nickname`, [room.id]);
console.log("votos:", JSON.stringify(votes, null, 1));
const { rows: nohuman } = await c.query(
  `SELECT v.round, count(*)::int AS n FROM public.votes v
    JOIN public.players p ON p.id = v.voter_id AND p.is_bot = false
   WHERE v.room_id = $1 GROUP BY v.round ORDER BY v.round`, [room.id]);
console.log("votos humanos por rodada:", JSON.stringify(nohuman));
await c.end();
