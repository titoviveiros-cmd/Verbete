// Auditoria completa da partida (uso: DB_URL=... CODE=1234 node scripts/match-audit.mjs)
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const code = process.env.CODE;

const room = await client.query("SELECT * FROM public.rooms WHERE code = $1", [code]);
const r = room.rows[0];
console.log("ROOM:", JSON.stringify({
  status: r.status, round: r.current_round, coordinator: r.current_coordinator,
  ends: r.round_phase_ends_at, win: `${r.win_condition}/${r.win_target}`,
}));

const players = await client.query(
  "SELECT p.id, p.nickname, p.is_bot, p.score, p.kicked_at IS NOT NULL AS kicked, p.writing_extensions, p.voting_extensions FROM public.players p WHERE p.room_id = $1 ORDER BY p.joined_at",
  [r.id],
);
console.log("PLAYERS:", JSON.stringify(players.rows));

const defs = await client.query(
  "SELECT round, player_id, letter, is_truth, left(text, 50) AS text FROM public.definitions WHERE room_id = $1 ORDER BY round, letter",
  [r.id],
);
console.log("DEFS:", JSON.stringify(defs.rows));

const votes = await client.query(
  "SELECT round, voter_id, definition_id FROM public.votes WHERE room_id = $1 ORDER BY round",
  [r.id],
);
console.log("VOTES:", JSON.stringify(votes.rows));

const rounds = await client.query(
  "SELECT round, coordinator_id, scored_at FROM public.rounds WHERE room_id = $1 ORDER BY round",
  [r.id],
);
console.log("ROUNDS:", JSON.stringify(rounds.rows));

await client.end();
