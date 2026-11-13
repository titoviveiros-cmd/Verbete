// Fase 3 (20261113090000_autorizacao_fase3): as RPCs que mudam a partida só
// para participantes ATIVOS da sala (e o papel certo onde o jogo exige),
// testadas pela API pública REAL (PostgREST do Supabase local da CI, chave
// publicável, sessões anônimas como o app e o vc8).
//   • sem sessão, sessão de fora e expulso → a MESMA resposta de sala
//     inexistente de cada RPC (sem oráculo) e a sala intacta;
//   • choose_word: só o coordenador; coordenador bot → qualquer participante;
//   • finish_reveal e placar com p_force: só o host;
//   • avanços por prazo/quórum: qualquer participante (o "quem estiver na sala
//     avança quando o prazo acaba" do cliente);
//   • várias sessões avançando ao mesmo tempo → um avanço só, sem erro.
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
const row = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const short = (x) => JSON.stringify(x ?? null).slice(0, 160);
const newClient = () =>
  createClient(SUPA_URL, ANON, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
async function withSession(label) {
  const c = newClient();
  const { data, error } = await c.auth.signInAnonymously();
  if (error || !data.user)
    throw new Error(`sessão anônima (${label}) falhou: ${error?.message}`);
  return { c, uid: data.user.id, label };
}

const applied = await row(
  `SELECT to_regprocedure('public.room_actor_gate(uuid)') IS NOT NULL AS ok`,
);
if (!applied.ok) {
  console.log("❌ migration 20261113090000 ausente neste banco");
  process.exit(1);
}

const anon = { c: newClient(), label: "sem sessão" };
const H = await withSession("host");
const G = await withSession("convidado");
const C = await withSession("coordenador");
const K = await withSession("expulso");
const O = await withSession("de fora (com sala própria)");

const tag = Math.random().toString(36).slice(2, 8);
const id = (k) => `f3_${k}_${tag}`;
const P = {
  H: id("h"),
  G: id("g"),
  C: id("c"),
  K: id("k"),
  O: id("o"),
  B: `bot_${tag}1`,
};
const GHOST = "00000000-0000-4000-8000-00000000f3f3"; // sala inexistente
const rooms = [];
const st = async (rid) =>
  row(
    `SELECT status, current_word_id, current_round, current_coordinator FROM public.rooms WHERE id = $1`,
    [rid],
  );
const call = async (who, fn, args) => {
  const { data, error } = await who.c.rpc(fn, args);
  return error ? { __error: `${error.code ?? ""} ${error.message}` } : data;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
console.log(
  "\n— Montagem pela API: sala do host, 3 convidados por código, 1 bot, partida iniciada",
);
const { data: room, error: cErr } = await H.c.rpc("create_room_with_host", {
  p_host_id: P.H,
  p_nickname: "Host",
  p_avatar: "🦊",
  p_color: "#f00",
});
if (cErr || !room?.id)
  throw new Error(`create_room_with_host: ${cErr?.message}`);
const rid = room.id;
rooms.push(rid);
for (const [s, pid] of [
  [G, P.G],
  [C, P.C],
  [K, P.K],
]) {
  const { error } = await s.c.rpc("rejoin_room", {
    p_code: room.code,
    p_player_id: pid,
    p_nickname: pid.slice(0, 8),
    p_avatar: "🐸",
    p_color: "#0f0",
  });
  if (error) throw new Error(`rejoin_room ${s.label}: ${error.message}`);
}
{
  const r = await call(H, "add_bot", {
    p_room_id: rid,
    p_actor_id: P.H,
    p_bot_id: P.B,
    p_nickname: "Bot",
    p_avatar: "🤖",
    p_color: "#abc",
  });
  check("host adiciona bot", r?.ok === true, short(r));
}
const { data: oRoom } = await O.c.rpc("create_room_with_host", {
  p_host_id: P.O,
  p_nickname: "Fora",
  p_avatar: "🐙",
  p_color: "#00f",
});
rooms.push(oRoom.id);
{
  const r = await call(H, "start_game", { p_room_id: rid });
  check("host inicia a partida", r?.ok === true, short(r));
  const k = await call(H, "kick_player", {
    p_room_id: rid,
    p_actor_id: P.H,
    p_target_player_id: P.K,
  });
  check("host expulsa K durante a partida", k?.ok === true, short(k));
}
const [w1, w2] = (
  await db.query(
    `SELECT id FROM public.words WHERE status = 'published' AND meaning IS NOT NULL
        AND id IS DISTINCT FROM (SELECT word_id FROM public.daily_challenges WHERE challenge_hour = date_trunc('hour', now()))
      ORDER BY id LIMIT 2`,
  )
).rows.map((r) => r.id);
// coordenador determinístico e prazo longe (o cron não interfere)
const setRoom = (sql, params = []) =>
  db.query(`UPDATE public.rooms SET ${sql} WHERE id = $1`, [rid, ...params]);
await setRoom(
  `current_coordinator = $2, round_phase_ends_at = now() + interval '10 minutes'`,
  [P.C],
);
await db.query(
  `UPDATE public.players SET joined_at = now() - interval '5 minutes' WHERE room_id = $1`,
  [rid],
);

// ---------------------------------------------------------------------------
console.log("\n— choose_word");
{
  const args = { p_room_id: rid, p_word_id: w1, p_duration_sec: 60 };
  const nope = await call(G, "choose_word", { ...args, p_room_id: GHOST });
  check(
    "sala inexistente → room_not_found",
    nope?.reason === "room_not_found",
    short(nope),
  );
  for (const who of [anon, O, K]) {
    const r = await call(who, "choose_word", args);
    check(
      `${who.label} → a mesma resposta de sala inexistente`,
      same(r, nope),
      short(r),
    );
  }
  check(
    "sala intacta (choosing, sem palavra)",
    (await st(rid)).status === "choosing" &&
      (await st(rid)).current_word_id === null,
  );
  for (const who of [G, H]) {
    const r = await call(who, "choose_word", args);
    check(
      `${who.label} (não coordenador) → not_authorized`,
      r?.reason === "not_authorized",
      short(r),
    );
  }
  const r = await call(C, "choose_word", args);
  check(
    "coordenador escolhe → ok",
    r?.ok === true && (await st(rid)).status === "writing",
    short(r),
  );
}

// ---------------------------------------------------------------------------
console.log("\n— Escrita → embaralhar → votação");
await setRoom(
  `round_phase_ends_at = now() + interval '10 minutes', phase_started_at = now() - interval '1 minute'`,
);
for (const [s, pid, text] of [
  [G, P.G, "instrumento de corda nordestino"],
  [H, P.H, "doce de leite com coco queimado"],
]) {
  const r = await call(s, "submit_definition", {
    p_room_id: rid,
    p_player_id: pid,
    p_text: text,
  });
  check(`${s.label} escreve`, r?.ok === true, short(r));
}
await db.query(
  `INSERT INTO public.definitions (room_id, round, player_id, text) VALUES ($1, 1, $2, 'peixe pequeno de rio')`,
  [rid, P.B],
);
{
  const nope = await call(G, "start_shuffling", { p_room_id: GHOST });
  for (const who of [anon, O, K]) {
    const r = await call(who, "start_shuffling", { p_room_id: rid });
    check(
      `start_shuffling ${who.label} → igual a sala inexistente (${short(nope)})`,
      same(r, nope),
      short(r),
    );
  }
  check("sala segue em writing", (await st(rid)).status === "writing");
  const r = await call(G, "start_shuffling", { p_room_id: rid });
  check("participante embaralha → ok", r?.ok === true, short(r));
  for (const who of [anon, O])
    await call(who, "advance_writing_to_voting", { p_room_id: rid });
  check(
    "advance_writing_to_voting de fora/sem sessão → nada muda (shuffling)",
    (await st(rid)).status === "shuffling",
  );
  await call(C, "advance_writing_to_voting", { p_room_id: rid });
  check(
    "coordenador (participante) abre a votação",
    (await st(rid)).status === "voting",
  );
}

// ---------------------------------------------------------------------------
console.log("\n— Votação → revelação (concorrência: 4 sessões ao mesmo tempo)");
await setRoom(`round_phase_ends_at = now() + interval '10 minutes'`);
const defs = Object.fromEntries(
  (
    await db.query(
      `SELECT player_id, id FROM public.definitions WHERE room_id = $1 AND round = 1`,
      [rid],
    )
  ).rows.map((x) => [x.player_id, x.id]),
);
for (const [s, pid, target] of [
  [G, P.G, defs[P.H]],
  [H, P.H, defs.__truth__],
  [C, P.C, defs[P.G]],
]) {
  const r = await call(s, "cast_vote", {
    p_room_id: rid,
    p_voter_id: pid,
    p_definition_id: target,
  });
  check(`${s.label} vota`, r == null || r?.ok !== false, short(r));
}
await db.query(
  `INSERT INTO public.votes (room_id, round, voter_id, definition_id) VALUES ($1, 1, $2, $3)`,
  [rid, P.B, defs[P.G]],
);
{
  for (const who of [anon, O, K])
    await call(who, "advance_voting_to_reveal", { p_room_id: rid });
  check(
    "advance_voting_to_reveal de fora/sem sessão/expulso → segue em voting",
    (await st(rid)).status === "voting",
  );
  const res = await Promise.all(
    [G, H, C, G].map((s, i) =>
      s.c.rpc(i % 2 ? "extend_voting_or_advance" : "advance_voting_to_reveal", {
        p_room_id: rid,
      }),
    ),
  );
  const errs = res.filter((r) => r.error);
  const n = await row(
    `SELECT count(*)::int n FROM public.rounds WHERE room_id = $1 AND round = 1`,
    [rid],
  );
  const sc = await row(`SELECT score FROM public.players WHERE id = $1`, [P.H]);
  // host: +3 (achou a verdade) +1 (G caiu no blefe dele) = 4, uma vez só
  check(
    "4 chamadas simultâneas de participantes → 0 erros HTTP, 1 rodada pontuada (host 4), reveal",
    errs.length === 0 &&
      n.n === 1 &&
      (await st(rid)).status === "reveal" &&
      sc.score === 4,
    `erros=${errs.length} rounds=${n.n} host=${sc.score} ${errs[0]?.error?.message ?? ""}`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n— finish_reveal: só o host");
{
  const nope = await call(G, "finish_reveal", { p_room_id: GHOST });
  for (const who of [anon, O, K]) {
    const r = await call(who, "finish_reveal", { p_room_id: rid });
    check(
      `finish_reveal ${who.label} → igual a sala inexistente`,
      same(r, nope),
      short(r),
    );
  }
  for (const who of [G, C]) {
    const r = await call(who, "finish_reveal", { p_room_id: rid });
    check(
      `finish_reveal ${who.label} → not_authorized`,
      r?.reason === "not_authorized",
      short(r),
    );
  }
  check("segue em reveal", (await st(rid)).status === "reveal");
  const r = await call(H, "finish_reveal", { p_room_id: rid });
  check(
    "host encerra a revelação → scoreboard",
    r?.ok === true && r?.status === "scoreboard",
    short(r),
  );
}

// ---------------------------------------------------------------------------
console.log(
  "\n— Placar: p_force só do host; sem p_force (prazo vencido) qualquer participante",
);
{
  const a = { p_room_id: rid, p_force: true };
  const nope = await call(G, "advance_scoreboard_to_next_round_or_finished", {
    ...a,
    p_room_id: GHOST,
  });
  for (const who of [anon, O, K]) {
    const r = await call(
      who,
      "advance_scoreboard_to_next_round_or_finished",
      a,
    );
    check(
      `placar ${who.label} → igual a sala inexistente`,
      same(r, nope),
      short(r),
    );
  }
  let r = await call(G, "advance_scoreboard_to_next_round_or_finished", a);
  check(
    "convidado com p_force → not_authorized",
    r?.reason === "not_authorized" && (await st(rid)).status === "scoreboard",
    short(r),
  );
  r = await call(G, "advance_scoreboard_to_next_round_or_finished", {
    p_room_id: rid,
    p_force: false,
  });
  check(
    "convidado sem p_force antes do prazo → noop_grace",
    r?.action === "noop_grace",
    short(r),
  );
  await setRoom(`round_phase_ends_at = now() - interval '5 seconds'`);
  r = await call(G, "advance_scoreboard_to_next_round_or_finished", {
    p_room_id: rid,
    p_force: false,
  });
  check(
    "convidado sem p_force com prazo vencido → next_round (como o cron)",
    r?.action === "next_round",
    short(r),
  );
}

// ---------------------------------------------------------------------------
console.log(
  "\n— Rodada 2: coordenador BOT → qualquer participante escolhe por ele",
);
await setRoom(
  `current_coordinator = $2, round_phase_ends_at = now() + interval '10 minutes'`,
  [P.B],
);
{
  let r = await call(O, "choose_word", {
    p_room_id: rid,
    p_word_id: w2,
    p_duration_sec: 60,
  });
  check("de fora continua recusado", r?.reason === "room_not_found", short(r));
  const res = await Promise.all(
    [H, G, C].map((s) =>
      s.c.rpc("choose_word", {
        p_room_id: rid,
        p_word_id: w2,
        p_duration_sec: 60,
      }),
    ),
  );
  const oks = res.filter((x) => x.data?.ok === true).length;
  check(
    "host + 2 participantes escolhem ao mesmo tempo pelo bot → 1 escolha, 0 erros",
    oks === 1 &&
      res.every((x) => !x.error) &&
      (await st(rid)).status === "writing",
    short(res.map((x) => x.data)),
  );
}

// ---------------------------------------------------------------------------
console.log("\n— Prazo da escrita vencido: prorrogação só por participante");
await setRoom(
  `round_phase_ends_at = now() - interval '10 seconds', phase_started_at = now() - interval '2 minutes'`,
);
{
  const nope = await call(G, "extend_writing_or_advance", { p_room_id: GHOST });
  const before = (
    await db.query(
      `SELECT id, score FROM public.players WHERE room_id = $1 ORDER BY id`,
      [rid],
    )
  ).rows;
  for (const who of [anon, O, K]) {
    const r = await call(who, "extend_writing_or_advance", { p_room_id: rid });
    check(
      `extend_writing ${who.label} → igual a sala inexistente`,
      same(r, nope),
      short(r),
    );
  }
  const after = (
    await db.query(
      `SELECT id, score FROM public.players WHERE room_id = $1 ORDER BY id`,
      [rid],
    )
  ).rows;
  check("ninguém foi punido pelas chamadas de fora", same(before, after));
  const r = await call(C, "extend_writing_or_advance", { p_room_id: rid });
  check(
    "participante no prazo vencido → extended (pendentes −1, +20 s)",
    r?.action === "extended",
    short(r),
  );
}

// ---------------------------------------------------------------------------
console.log("\n— Funções novas não são executáveis pela API");
{
  for (const [fn, args] of [
    ["room_actor_gate", { p_room_id: rid }],
    ["room_actor_is", { p_room_id: rid, p_player_id: P.G }],
  ]) {
    const r = await G.c.rpc(fn, args);
    check(
      `${fn} pela API → recusada`,
      !!r.error,
      r.error?.code ?? short(r.data),
    );
  }
}

for (const r of rooms)
  await db.query(`DELETE FROM public.rooms WHERE id = $1`, [r]);
await db.end();
console.log(`\n${total - fails}/${total} verificações OK`);
process.exit(fails ? 1 : 0);
