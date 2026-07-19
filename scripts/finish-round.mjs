// Completa a rodada em andamento validando as 3 regras de pontuação:
//   humano vota no blefe do bot  -> bot +50 (enganou)
//   bot vota na verdade          -> bot +100 (acertou)
//   ninguém achou a verdade? não — bot achou; então SEM bônus de coordenador.
// Ajuste: para validar o bônus do coordenador (+50), o bot também vota no
// próprio... não pode. Então: humano vota blefe do bot; bot NÃO vota.
//   -> bot +50; truth_voters=0 e total_votes>0 -> coordenador (humano) +50.
// Uso: SUPA_URL=... ANON=... DB_URL=... CODE=1234 node scripts/finish-round.mjs
import pg from "pg";

const { SUPA_URL, ANON, DB_URL, CODE } = process.env;

const rpc = async (fn, body) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`  rpc ${fn} -> ${r.status} ${(await r.text()).slice(0, 160)}`);
};

const db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const getRoom = async () => (await db.query("SELECT * FROM public.rooms WHERE code = $1", [CODE])).rows[0];

let room = await getRoom();
console.log(`start: ${room.status} r${room.current_round}`);
const beforeScores = (await db.query("SELECT nickname, score FROM public.players WHERE room_id = $1", [room.id])).rows;
console.log("scores before:", JSON.stringify(beforeScores));

if (room.status === "writing") {
  await rpc("start_shuffling", { p_room_id: room.id });
  room = await getRoom();
}
if (room.status === "shuffling") {
  await rpc("advance_writing_to_voting", { p_room_id: room.id });
  room = await getRoom();
  console.log(`now: ${room.status}`);
}

if (room.status !== "voting") { console.log("FAIL: not voting"); process.exit(1); }

const { rows: players } = await db.query(
  "SELECT id, nickname, is_bot FROM public.players WHERE room_id = $1 AND kicked_at IS NULL", [room.id],
);
const human = players.find((p) => !p.is_bot);
const bot = players.find((p) => p.is_bot);

const { rows: ballot } = await db.query(
  "SELECT id, player_id, letter, left(text,45) t FROM public.definitions WHERE room_id = $1 AND round = $2 ORDER BY letter",
  [room.id, room.current_round],
);
console.log("ballot:", JSON.stringify(ballot));
const botDef = ballot.find((d) => d.player_id === bot?.id);

// Humano (coordenador) cai no blefe do bot; bot não vota.
await rpc("cast_vote", { p_room_id: room.id, p_voter_id: human.id, p_definition_id: botDef.id });
await rpc("advance_voting_to_reveal", { p_room_id: room.id });

room = await getRoom();
const afterScores = (await db.query("SELECT nickname, score FROM public.players WHERE room_id = $1", [room.id])).rows;
console.log(`RESULT: status=${room.status}`);
console.log("scores after:", JSON.stringify(afterScores));
console.log("esperado: bot +50 (voto no blefe dele); coordenador humano +50 (ninguem achou a verdade)");
await db.end();
