// Voto dos bots decidido no SERVIDOR (playtest 2026-10-22): cast_bot_votes
// vota na verdade com 17,5% de chance (nunca acima do chute às cegas) e, no
// resto, num blefe aleatório que não seja o do bot — e só depois que todos
// os humanos votaram (ou passado o prazo). Prova: a escolha pura (grades
// determinísticas), a RPC numa amostra grande, nunca a própria cédula,
// qualquer humano da sala pede (bot e estranho não), nada da verdade na
// resposta, o placar do motor intacto e a reversão limpa.
// Envs: SUPA_URL, ANON, DB_URL.
import { readFileSync } from "node:fs";
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
const short = (x) => JSON.stringify(x ?? null).slice(0, 160);
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

// 1) Escolha pura. Mesa de 4 (2 blefes à escolha): grade 40×40 →
//    exatamente 17,5% na verdade e o resto igual entre os blefes.
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
  "escolha pura (mesa de 4): 17,5% na verdade, o resto igual entre os blefes",
  Number(g.truth) === 280 && Number(g.b1) === 660 && Number(g.b2) === 660,
  `verdade=${g.truth} blefe1=${g.b1} blefe2=${g.b2} de ${g.n}`,
);
// Mesa de 12 (11 blefes à escolha): nunca acima do chute às cegas (1/12)
const big = await row(
  `WITH b AS (SELECT array_agg(gen_random_uuid()) AS ids FROM generate_series(1, 11)),
        t AS (SELECT gen_random_uuid() AS id),
        picks AS (
          SELECT public.bot_vote_pick(t.id, b.ids, (i + 0.5) / 120.0, (j + 0.5) / 11.0) AS pick, t.id AS truth, b.ids
            FROM t, b, generate_series(0, 119) i, generate_series(0, 10) j)
   SELECT count(*) FILTER (WHERE pick = truth) AS truth,
          (SELECT min(c) FROM (SELECT count(*) AS c FROM picks WHERE pick <> truth GROUP BY pick) x) AS bluff_min,
          (SELECT max(c) FROM (SELECT count(*) AS c FROM picks WHERE pick <> truth GROUP BY pick) x) AS bluff_max,
          count(*) AS n
     FROM picks`,
);
check(
  "mesa de 12: nunca acima do chute às cegas (1/12 = 8,3%; antes 17,5% seria o dobro)",
  Number(big.truth) === 110 &&
    Number(big.bluff_min) === 110 &&
    Number(big.bluff_max) === 110,
  `verdade=${big.truth} de ${big.n}; blefes ${big.bluff_min}–${big.bluff_max}`,
);
const edge = await row(
  `SELECT public.bot_vote_pick('00000000-0000-4000-8000-000000000001', ARRAY[]::uuid[], 0.9, 0.5) AS only_truth,
          public.bot_vote_pick(NULL, ARRAY['00000000-0000-4000-8000-000000000002'::uuid], 0.0, 0.99) AS no_truth`,
);
check(
  "sem blefe sobra a verdade; sem verdade, só blefe",
  edge.only_truth === "00000000-0000-4000-8000-000000000001" &&
    edge.no_truth === "00000000-0000-4000-8000-000000000002",
  short(edge),
);

// 2) A RPC numa sala de verdade: 2 humanos + 3 bots, rodada em votação.
const tag = Math.random().toString(36).slice(2, 8);
const [host, p2, stranger] = [
  await session(),
  await session(),
  await session(),
];
const H = `bv_h_${tag}`;
const P2 = `bv_p2_${tag}`;
const BOTS = [1, 2, 3].map((i) => `bv_b${i}_${tag}`);
const { data: room, error: roomErr } = await host.rpc("create_room_with_host", {
  p_host_id: H,
  p_nickname: "Host",
  p_avatar: "🦊",
  p_color: "#f00",
});
if (roomErr) throw roomErr;
const { error: joinErr } = await p2.rpc("rejoin_room", {
  p_code: room.code,
  p_player_id: P2,
  p_nickname: "Segundo",
  p_avatar: "🐸",
  p_color: "#0f0",
});
if (joinErr) throw joinErr;
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
// verdade + blefes de 2 bots e dos 2 humanos (o 3º bot coordena: sem blefe)
const defs = await rows(
  `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, letter) VALUES
     ($1, 1, '__truth__', 'a verdade da rodada', true, 'A'),
     ($1, 1, $2, 'blefe do bot 1', false, 'B'),
     ($1, 1, $3, 'blefe do bot 2', false, 'C'),
     ($1, 1, $4, 'blefe do host', false, 'D'),
     ($1, 1, $5, 'blefe do segundo', false, 'E')
   RETURNING id, player_id, is_truth`,
  [room.id, BOTS[0], BOTS[1], H, P2],
);
const truthId = defs.find((d) => d.is_truth).id;
const defOf = (pid) => defs.find((d) => d.player_id === pid).id;
const ownerOf = Object.fromEntries(defs.map((d) => [d.id, d.player_id]));
const ask = (client, actor, round = 1) =>
  client.rpc("cast_bot_votes", {
    p_room_id: room.id,
    p_round: round,
    p_actor_id: actor,
  });
const botVoteCount = async () =>
  Number(
    (
      await row(
        `SELECT count(*) AS n FROM public.votes WHERE room_id = $1 AND round = 1 AND voter_id = ANY($2)`,
        [room.id, BOTS],
      )
    ).n,
  );
const humanVote = (voter, def) =>
  db.query(
    `INSERT INTO public.votes (room_id, round, voter_id, definition_id) VALUES ($1, 1, $2, $3)`,
    [room.id, voter, def],
  );

let r = await ask(host, H);
check(
  "ninguém votou: os bots esperam (humans_pending), nenhum voto de bot",
  r.data?.reason === "humans_pending" && (await botVoteCount()) === 0,
  short(r.data ?? r.error),
);
await humanVote(H, defOf(P2));
r = await ask(host, H);
check(
  "um humano ainda devendo: segue esperando",
  r.data?.reason === "humans_pending",
  short(r.data),
);
r = await ask(host, BOTS[0]);
check(
  "bot não pede voto de bot",
  r.data?.reason === "not_authorized",
  short(r.data ?? r.error),
);
r = await ask(stranger, H);
check(
  "quem não é da sala (ou finge ser o host) não pede",
  r.data?.reason === "not_authorized",
  short(r.data ?? r.error),
);
await humanVote(P2, truthId);
r = await ask(p2, P2);
check(
  "todos os humanos votaram: o 2º humano (não o host) pede e os 3 bots votam — resposta só {ok, inserted}",
  r.data?.ok === true &&
    r.data?.inserted === 3 &&
    JSON.stringify(Object.keys(r.data).sort()) ===
      JSON.stringify(["inserted", "ok"]),
  short(r.data ?? r.error),
);
r = await ask(host, H);
check(
  "pedir de novo (outro aparelho) não vota de novo",
  r.data?.ok === true && r.data?.inserted === 0,
  short(r.data),
);
r = await ask(host, H, 2);
check(
  "rodada errada não vota",
  r.data?.reason === "invalid_state",
  short(r.data),
);

// prazo vencido (+2 s de folga) com humano devendo: os bots votam
await db.query(
  `DELETE FROM public.votes WHERE room_id = $1 AND round = 1 AND voter_id = ANY($2)`,
  [room.id, [...BOTS, P2]],
);
await db.query(
  `UPDATE public.rooms SET round_phase_ends_at = now() - interval '5 seconds' WHERE id = $1`,
  [room.id],
);
r = await ask(host, H);
check(
  "prazo vencido com humano devendo: os bots votam mesmo assim",
  r.data?.ok === true && r.data?.inserted === 3,
  short(r.data),
);
await db.query(
  `UPDATE public.rooms SET round_phase_ends_at = now() + interval '10 minutes' WHERE id = $1`,
  [room.id],
);
await humanVote(P2, truthId);

// amostra grande: 150 rodadas "repetidas" (apaga só os votos dos bots)
let botVotes = 0;
let onTruth = 0;
let onOwn = 0;
let invalid = 0;
for (let k = 0; k < 150; k++) {
  await db.query(
    `DELETE FROM public.votes WHERE room_id = $1 AND round = 1 AND voter_id = ANY($2)`,
    [room.id, BOTS],
  );
  const x = await ask(host, H);
  if (x.data?.inserted !== 3) invalid++;
  for (const v of await rows(
    `SELECT voter_id, definition_id FROM public.votes WHERE room_id = $1 AND round = 1 AND voter_id = ANY($2)`,
    [room.id, BOTS],
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

// 3) Placar do motor intacto
const votes = await rows(
  `SELECT voter_id, definition_id FROM public.votes WHERE room_id = $1 AND round = 1`,
  [room.id],
);
const expected = Object.fromEntries([H, P2, ...BOTS].map((p) => [p, 0]));
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
  [H, P2, ...BOTS].every((p) => scores[p] === expected[p]),
  `esperado=${short(expected)} obtido=${short(scores)}`,
);

// 4) Reversão aplica limpa (dentro de transação desfeita)
await db.query("BEGIN");
try {
  await db.query(readFileSync("supabase/rollback/bot_vote_policy.sql", "utf8"));
  const fn = await row(
    `SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('cast_bot_votes', 'bot_vote_pick')`,
  );
  check("rollback remove as duas funções", fn.n === 0, short(fn));
} catch (e) {
  check("rollback remove as duas funções", false, e.message);
} finally {
  await db.query("ROLLBACK");
}

await db.query(`DELETE FROM public.rooms WHERE id = $1`, [room.id]);
await db.query(`DELETE FROM public.players WHERE id = ANY($1)`, [
  [H, P2, ...BOTS],
]);
await db.end();
console.log(
  fails
    ? `\n${fails}/${total} FALHAS`
    : `\nVOTO DOS BOTS OK — ${total}/${total}`,
);
process.exit(fails ? 1 : 0);
