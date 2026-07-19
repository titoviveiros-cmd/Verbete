// Simula ações de jogadores via REST (como um client real faria):
// bot escreve, todos votam na verdade. Uso:
//   SUPA_URL=... ANON=... DB_URL=... CODE=1234 node scripts/play-round.mjs
import pg from "pg";

const { SUPA_URL, ANON, DB_URL, CODE } = process.env;

const rpc = async (fn, body) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`rpc ${fn} -> ${r.status} ${text.slice(0, 200)}`);
  return text;
};

const db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows: [room] } = await db.query("SELECT * FROM public.rooms WHERE code = $1", [CODE]);
console.log("room:", room.status, "round", room.current_round);

const { rows: players } = await db.query(
  "SELECT id, nickname, is_bot FROM public.players WHERE room_id = $1 AND kicked_at IS NULL",
  [room.id],
);
const bot = players.find((p) => p.is_bot);
const human = players.find((p) => !p.is_bot);

if (room.status === "writing" && bot) {
  // Bot envia definição falsa (mesma RPC que o client usa)
  await rpc("submit_bot_definitions_bulk", {
    p_room_id: room.id,
    p_round: room.current_round,
    p_rows: [{ player_id: bot.id, text: "tapete rustico tecido com fibras de palmeira" }],
  });
  // Coordenador é o único humano -> ninguém mais pendente; cron avançaria,
  // mas chamamos o nudge como o client faria:
  await rpc("extend_writing_or_advance", { p_room_id: room.id });
}

const { rows: [room2] } = await db.query("SELECT * FROM public.rooms WHERE code = $1", [CODE]);
console.log("room now:", room2.status);

if (room2.status === "voting") {
  const { rows: defs } = await db.query(
    "SELECT id, player_id, letter, left(text,40) t FROM public.definitions WHERE room_id = $1 AND round = $2 ORDER BY letter",
    [room2.id, room2.current_round],
  );
  console.log("ballot:", JSON.stringify(defs));
  const truth = defs.find((d) => d.player_id === "__truth__");
  // Humano (coordenador vota também) acerta a verdade; bot vota na verdade
  // (única opção que não é a própria definição).
  if (truth && human) await rpc("cast_vote", { p_room_id: room2.id, p_voter_id: human.id, p_definition_id: truth.id });
  if (truth && bot) await rpc("cast_votes_bulk", { p_room_id: room2.id, p_round: room2.current_round, p_votes: [{ voter_id: bot.id, definition_id: truth.id }] });
  await rpc("advance_voting_to_reveal", { p_room_id: room2.id });
}

const { rows: [room3] } = await db.query("SELECT * FROM public.rooms WHERE code = $1", [CODE]);
const { rows: scores } = await db.query(
  "SELECT nickname, score FROM public.players WHERE room_id = $1 ORDER BY score DESC",
  [room3.id],
);
console.log("FINAL:", room3.status, JSON.stringify(scores));
await db.end();
