// Voto dos bots decidido no SERVIDOR (playtest 2026-10-22): cast_bot_votes
// vota na verdade com 17,5% de chance e, no resto, num blefe aleatório que
// não seja o do bot. Prova: a escolha pura (grade determinística), a RPC
// numa amostra grande, nunca a própria cédula, só o host, nada da verdade na
// resposta e o placar do motor intacto.
// Envs: SUPA_URL, ANON, DB_URL.
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const { SUPA_URL, ANON, DB_URL } = process.env;
const db = new pg.Client({
  connectionString: DB_URL,
  ssl: /supabase\.co/.test(DB_URL ?? "")
    ? { rejectUnauthorized: false }
    : false,
});
await db.connect();
let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const rows = async (sql, p = []) => (await db.query(sql, p)).rows;
const row = async (sql, p = []) => (await rows(sql, p))[0];
const session = async () => {
  const c = createClient(SUPA_URL, ANON, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { error } = await c.auth.signInAnonymously();
  if (error) throw error;
  return c;
};

// 1) Escolha pura: grade 40×40 de sorteios → exatamente 17,5% na verdade e
//    o resto dividido igualmente entre os blefes.
const g = await row(
  `WITH ids AS (SELECT gen_random_uuid() AS t, gen_random_uuid() AS b1, gen_random_uuid() AS b2),
        picks AS (
          SELECT public.bot_vote_pick(ids.t, ARRAY[ids.b1, ids.b2], (i + 0.5) / 40.0, (j + 0.5) / 40.0) AS pick, ids.*
            FROM ids, generate_series(0, 39) i, generate_series(0, 39) j)
   SELECT count(*) FILTER (WHERE pick = t) AS truth,
          count(*) FILTER (WHERE pick = b1) AS b1,
          count(*) FILTER (WHERE pick = b2) AS b2,
          count(*) AS n
     FROM picks`,
);
check(
  "escolha pura: 17,5% na verdade e o resto igual entre os blefes (grade 40×40)",
  Number(g.truth) === 280 && Number(g.b1) === 660 && Number(g.b2) === 660,
  `verdade=${g.truth} blefe1=${g.b1} blefe2=${g.b2} de ${g.n}`,
);
const edge = await row(
  `SELECT public.bot_vote_pick('00000000-0000-4000-8000-000000000001', ARRAY[]::uuid[], 0.9, 0.5) AS only_truth,
          public.bot_vote_pick(NULL, ARRAY['00000000-0000-4000-8000-000000000002'::uuid], 0.0, 0.99) AS no_truth`,
);
check(
  "sem blefe sobra a verdade; sem verdade, só blefe",
  edge.only_truth === "00000000-0000-4000-8000-000000000001" &&
    edge.no_truth === "00000000-0000-4000-8000-000000000002",
  JSON.stringify(edge),
);

// 2) A RPC numa sala de verdade: host humano + 3 bots, rodada em votação.
const tag = Math.random().toString(36).slice(2, 8);
const host = await session();
const stranger = await session();
const H = `bv_h_${tag}`;
const BOTS = [1, 2, 3].map((i) => `bv_b${i}_${tag}`);
const { data: room, error: roomErr } = await host.rpc("create_room_with_host", {
  p_host_id: H,
  p_nickname: "Host",
  p_avatar: "🦊",
  p_color: "#f00",
});
if (roomErr) throw roomErr;
for (const b of BOTS)
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, joined_at)
     VALUES ($1, $2, $1, '🤖', '#444', true, now() - interval '5 minutes')`,
    [b, room.id],
  );
await db.query(
  `UPDATE public.rooms
      SET status = 'voting', current_round = 1, current_coordinator = $2,
          round_phase_ends_at = now() + interval '10 minutes',
          phase_started_at = now() - interval '1 minute'
    WHERE id = $1`,
  [room.id, BOTS[2]],
);
// verdade + blefes de 2 bots e do host (o 3º bot é o coordenador: sem blefe)
const defs = await rows(
  `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, letter) VALUES
     ($1, 1, '__truth__', 'a verdade da rodada', true, 'A'),
     ($1, 1, $2, 'blefe do bot 1', false, 'B'),
     ($1, 1, $3, 'blefe do bot 2', false, 'C'),
     ($1, 1, $4, 'blefe do host', false, 'D')
   RETURNING id, player_id, is_truth`,
  [room.id, BOTS[0], BOTS[1], H],
);
const truthId = defs.find((d) => d.is_truth).id;
const ownerOf = Object.fromEntries(defs.map((d) => [d.id, d.player_id]));

const first = await host.rpc("cast_bot_votes", {
  p_room_id: room.id,
  p_round: 1,
});
check(
  "host pede: os 3 bots votam (o coordenador também), resposta só {ok, inserted}",
  first.data?.ok === true &&
    first.data?.inserted === 3 &&
    JSON.stringify(Object.keys(first.data).sort()) ===
      JSON.stringify(["inserted", "ok"]),
  JSON.stringify(first.data ?? first.error),
);
const again = await host.rpc("cast_bot_votes", {
  p_room_id: room.id,
  p_round: 1,
});
check(
  "pedir de novo não vota de novo",
  again.data?.ok === true && again.data?.inserted === 0,
  JSON.stringify(again.data),
);
const intruder = await stranger.rpc("cast_bot_votes", {
  p_room_id: room.id,
  p_round: 1,
});
check(
  "quem não é o host não comanda os bots",
  intruder.data?.reason === "not_authorized",
  JSON.stringify(intruder.data ?? intruder.error),
);
const wrongRound = await host.rpc("cast_bot_votes", {
  p_room_id: room.id,
  p_round: 2,
});
check(
  "rodada errada não vota",
  wrongRound.data?.reason === "invalid_state",
  JSON.stringify(wrongRound.data),
);

// amostra grande: 150 rodadas "repetidas" (apaga os votos e pede de novo)
let botVotes = 0;
let onTruth = 0;
let onOwn = 0;
let invalid = 0;
for (let k = 0; k < 150; k++) {
  await db.query(`DELETE FROM public.votes WHERE room_id = $1 AND round = 1`, [
    room.id,
  ]);
  const r = await host.rpc("cast_bot_votes", {
    p_room_id: room.id,
    p_round: 1,
  });
  if (r.data?.inserted !== 3) invalid++;
  for (const v of await rows(
    `SELECT voter_id, definition_id FROM public.votes WHERE room_id = $1 AND round = 1`,
    [room.id],
  )) {
    botVotes++;
    if (v.definition_id === truthId) onTruth++;
    if (ownerOf[v.definition_id] === v.voter_id) onOwn++;
    if (!(v.definition_id in ownerOf)) invalid++;
  }
}
const rate = onTruth / botVotes;
check(
  "amostra grande: ~17,5% dos votos de bot na verdade (antes: ~1/3)",
  botVotes === 450 && rate >= 0.09 && rate <= 0.27,
  `${onTruth}/${botVotes} = ${(rate * 100).toFixed(1)}%`,
);
check(
  "nenhum bot votou na própria cédula; todo voto válido",
  onOwn === 0 && invalid === 0,
  `própria=${onOwn} inválidos=${invalid}`,
);

// 3) Placar do motor intacto: host vota na verdade e a rodada pontua.
await db.query(`DELETE FROM public.votes WHERE room_id = $1 AND round = 1`, [
  room.id,
]);
await host.rpc("cast_bot_votes", { p_room_id: room.id, p_round: 1 });
await db.query(
  `INSERT INTO public.votes (room_id, round, voter_id, definition_id) VALUES ($1, 1, $2, $3)`,
  [room.id, H, truthId],
);
const votes = await rows(
  `SELECT voter_id, definition_id FROM public.votes WHERE room_id = $1 AND round = 1`,
  [room.id],
);
const expected = Object.fromEntries([H, ...BOTS].map((p) => [p, 0]));
for (const v of votes) {
  if (v.definition_id === truthId) expected[v.voter_id] += 3;
  else expected[ownerOf[v.definition_id]] += 1;
}
if (!votes.some((v) => v.definition_id === truthId)) expected[BOTS[2]] += 2;
await db.query(
  `UPDATE public.rooms SET round_phase_ends_at = now() - interval '1 minute' WHERE id = $1`,
  [room.id],
);
await db.query(`SELECT public.advance_voting_to_reveal($1)`, [room.id]);
const scores = Object.fromEntries(
  (
    await rows(`SELECT id, score FROM public.players WHERE room_id = $1`, [
      room.id,
    ])
  ).map((p) => [p.id, p.score]),
);
check(
  "placar do motor intacto (+3 verdade, +1 por voto no blefe, +2 coordenador)",
  [H, ...BOTS].every((p) => scores[p] === expected[p]),
  `esperado=${JSON.stringify(expected)} obtido=${JSON.stringify(scores)}`,
);

await db.query(`DELETE FROM public.rooms WHERE id = $1`, [room.id]);
await db.query(`DELETE FROM public.players WHERE id = ANY($1)`, [[H, ...BOTS]]);
await db.end();
console.log(
  fails
    ? `\n${fails}/${total} FALHAS`
    : `\nVOTO DOS BOTS OK — ${total}/${total}`,
);
process.exit(fails ? 1 : 0);
