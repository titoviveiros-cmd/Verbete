// Rodada completa coreografada via RPCs (valida +100 acerto / +50 blefe).
// Espera o cron levar a sala até 'choosing', então: escolhe palavra,
// humano escreve blefe, votos (humano->verdade, bot->blefe do humano),
// revela e confere o placar.
// Uso: SUPA_URL=... ANON=... DB_URL=... CODE=1234 node scripts/play-full-round.mjs
import pg from "pg";

const { SUPA_URL, ANON, DB_URL, CODE } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rpc = async (fn, body) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`  rpc ${fn} -> ${r.status} ${text.slice(0, 160)}`);
  return { status: r.status, text };
};

const db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

const getRoom = async () => (await db.query("SELECT * FROM public.rooms WHERE code = $1", [CODE])).rows[0];

// 1) Espera 'choosing' (cron avança reveal->scoreboard->choosing sozinho)
let room = await getRoom();
console.log(`start: ${room.status} r${room.current_round}`);
for (let i = 0; i < 40 && room.status !== "choosing"; i++) {
  await sleep(10000);
  room = await getRoom();
  console.log(`  waiting cron... ${room.status} r${room.current_round}`);
}
if (room.status !== "choosing") { console.log("FAIL: never reached choosing"); process.exit(1); }

const { rows: players } = await db.query(
  "SELECT id, nickname, is_bot FROM public.players WHERE room_id = $1 AND kicked_at IS NULL",
  [room.id],
);
const human = players.find((p) => !p.is_bot);
const coordinator = players.find((p) => p.id === room.current_coordinator);
console.log(`round ${room.current_round}: coordinator = ${coordinator?.nickname}`);

// 2) Escolhe palavra (como o client do coordenador — ou autopick — faria)
const used = room.used_word_ids ?? [];
const { rows: [word] } = await db.query(
  "SELECT id, word FROM public.words WHERE NOT (id = ANY($1::uuid[])) ORDER BY random() LIMIT 1",
  [used],
);
console.log(`word: ${word.word}`);
await rpc("choose_word", { p_room_id: room.id, p_word_id: word.id, p_duration_sec: 60 });

// 3) Escrita
room = await getRoom();
const humanIsCoordinator = room.current_coordinator === human.id;
const bot = players.find((p) => p.is_bot);
if (!humanIsCoordinator) {
  await rpc("submit_definition", { p_room_id: room.id, p_player_id: human.id, p_text: "antigo selo de chumbo usado em cartas reais" });
} else if (bot) {
  await rpc("submit_bot_definitions_bulk", {
    p_room_id: room.id, p_round: room.current_round,
    p_rows: [{ player_id: bot.id, text: "tapete rustico tecido com fibras de palmeira" }],
  });
}
// Caminho feliz do client: shuffling -> advance (aceita shuffling pós-fix)
await rpc("start_shuffling", { p_room_id: room.id });
await rpc("advance_writing_to_voting", { p_room_id: room.id });

room = await getRoom();
console.log(`after writing: ${room.status}`);
if (room.status !== "voting") { console.log("FAIL: not voting"); process.exit(1); }

// 4) Votação: humano vota na VERDADE (+100); bot vota no blefe do humano (+50 pro autor)
const { rows: ballot } = await db.query(
  "SELECT id, player_id, letter, left(text,45) t FROM public.definitions WHERE room_id = $1 AND round = $2 ORDER BY letter",
  [room.id, room.current_round],
);
console.log("ballot:", JSON.stringify(ballot));
const truth = ballot.find((d) => d.player_id === "__truth__");
const humanDef = ballot.find((d) => d.player_id === human.id);

await rpc("cast_vote", { p_room_id: room.id, p_voter_id: human.id, p_definition_id: truth.id });
if (bot) {
  const target = humanDef ?? truth;
  await rpc("cast_votes_bulk", { p_room_id: room.id, p_round: room.current_round, p_votes: [{ voter_id: bot.id, definition_id: target.id }] });
}

// 5) Revela e pontua
await rpc("advance_voting_to_reveal", { p_room_id: room.id });

room = await getRoom();
const { rows: scores } = await db.query(
  "SELECT nickname, score FROM public.players WHERE room_id = $1 ORDER BY score DESC",
  [room.id],
);
console.log(`RESULT: status=${room.status} scores=${JSON.stringify(scores)}`);
console.log(humanIsCoordinator
  ? "expectativa: humano +100 (verdade). Bot votou na verdade tambem? nao — coordenador nao escreve; bot votou na verdade -> bot +100"
  : "expectativa: humano +100 (acertou) +50 (bot caiu no blefe) = +150");
await db.end();
