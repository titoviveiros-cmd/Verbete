// M1 · Lote A — testes NEGATIVOS reais pela API pública (chave publicável),
// sem sessão e com sessão anônima, seguidos da prova de que os fluxos
// legítimos continuam funcionando ponta a ponta: criar, entrar, reivindicar
// identidade, bots, iniciar, escrever, embaralhar, votar, revelar, pontuar
// (pontuação ORIGINAL congelada), próxima rodada, fim, XP e revanche.
// Envs: SUPA_URL, ANON, DB_URL (Supabase local do CI).
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const { SUPA_URL, ANON, DB_URL } = process.env;
const db = new pg.Client({
  connectionString: DB_URL,
  ssl: /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false,
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
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const short = (x) => JSON.stringify(x ?? null).slice(0, 140);

const newClient = () =>
  createClient(SUPA_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
async function withSession(label) {
  const c = newClient();
  const { data, error } = await c.auth.signInAnonymously();
  if (error || !data.user) throw new Error(`sessão anônima (${label}) falhou: ${error?.message}`);
  return { c, uid: data.user.id, label };
}

const anon = { c: newClient(), uid: null, label: "sem sessão" };
const A = await withSession("Alice/host");
const B = await withSession("Bob");
const E = await withSession("Eve (membro malicioso)");
const M = await withSession("Mallory (de fora)");

const tag = Math.random().toString(36).slice(2, 8);
const ALICE = `sec_a_${tag}`;
const BOB = `sec_b_${tag}`;
const EVE = `sec_e_${tag}`;
const BOT1 = `bot_${tag}1`;
const BOT2 = `bot_${tag}2`;
const createdRooms = [];

// ---------------------------------------------------------------------------
console.log("\n— Sessão obrigatória para agir em nome de jogador");
{
  const { error } = await anon.c.rpc("create_room_with_host", {
    p_host_id: `sec_x_${tag}`, p_nickname: "X", p_avatar: "x", p_color: "#000",
  });
  check("criar sala SEM sessão é recusado (session_required)", /session_required/.test(error?.message ?? ""), error?.message);
}

const { data: room, error: createErr } = await A.c.rpc("create_room_with_host", {
  p_host_id: ALICE, p_nickname: "Alice", p_avatar: "🦊", p_color: "#f00",
});
check("Alice cria a sala com sessão", !!room?.id, createErr?.message ?? room?.code);
if (!room?.id) {
  console.log("abortando: sem sala");
  process.exit(1);
}
const rid = room.id;
createdRooms.push(rid);
for (const [who, id, nick] of [[B, BOB, "Bob"], [E, EVE, "Eve"]]) {
  const { error } = await who.c.rpc("rejoin_room", {
    p_code: room.code, p_player_id: id, p_nickname: nick, p_avatar: "🐸", p_color: "#0f0",
  });
  check(`${nick} entra na sala`, !error, error?.message);
}
const claims = await rows(`SELECT id, user_id::text FROM public.players WHERE room_id = $1`, [rid]);
const uidOf = Object.fromEntries(claims.map((p) => [p.id, p.user_id]));
check(
  "identidades reivindicadas no create/join (user_id = auth.uid())",
  uidOf[ALICE] === A.uid && uidOf[BOB] === B.uid && uidOf[EVE] === E.uid,
  short(uidOf),
);
{
  const { error } = await anon.c.rpc("rejoin_room", {
    p_code: room.code, p_player_id: `sec_y_${tag}`, p_nickname: "Y", p_avatar: "y", p_color: "#111",
  });
  check("entrar SEM sessão é recusado", /session_required/.test(error?.message ?? ""), error?.message);
}

// ---------------------------------------------------------------------------
console.log("\n— Escrita direta nas tabelas (PATCH/POST/DELETE via REST)");
const before = await row(
  `SELECT score, user_id::text, kicked_at, is_bot, coordinator_count FROM public.players WHERE id = $1`,
  [BOB],
);
for (const actor of [anon, E]) {
  const L = `[${actor.label}]`;
  let r = await actor.c.from("players").update({ score: 999 }).eq("id", BOB).select();
  r = await actor.c.from("players").update({ user_id: actor.uid ?? E.uid }).eq("id", BOB).select();
  r = await actor.c.from("players").update({ kicked_at: new Date().toISOString() }).eq("id", ALICE).select();
  r = await actor.c.from("players").update({ is_bot: true, coordinator_count: 9 }).eq("id", BOB).select();
  const after = await row(
    `SELECT score, user_id::text, kicked_at, is_bot, coordinator_count FROM public.players WHERE id = $1`,
    [BOB],
  );
  const alice = await row(`SELECT kicked_at FROM public.players WHERE id = $1`, [ALICE]);
  check(
    `${L} PATCH players.score/user_id/kicked_at/is_bot/coordinator_count não altera nada`,
    JSON.stringify(after) === JSON.stringify(before) && alice.kicked_at === null,
    r.error?.code ?? "sem erro (RLS)",
  );

  r = await actor.c.from("players").insert({
    id: `sec_fake_${tag}`, room_id: rid, nickname: "Fake", avatar: "x", color: "#000", score: 50,
  });
  const fake = await row(`SELECT 1 AS x FROM public.players WHERE id = $1`, [`sec_fake_${tag}`]);
  check(`${L} INSERT direto em players bloqueado`, !fake, r.error?.code);

  r = await actor.c.from("rooms").update({ host_id: EVE }).eq("id", rid).select();
  const host = await row(`SELECT host_id FROM public.rooms WHERE id = $1`, [rid]);
  check(`${L} PATCH rooms.host_id (roubo de host) bloqueado`, host.host_id === ALICE, r.error?.code);

  r = await actor.c.from("rooms").insert({ code: "0001", host_id: EVE, status: "lobby" });
  check(`${L} INSERT direto em rooms bloqueado`, !!r.error, r.error?.code);

  r = await actor.c.from("rooms").delete().eq("id", rid);
  const still = await row(`SELECT 1 AS x FROM public.rooms WHERE id = $1`, [rid]);
  check(`${L} DELETE de sala bloqueado`, !!still, r.error?.code);

  r = await actor.c.from("rounds").insert({ room_id: rid, round: 1, coordinator_id: EVE });
  const rr = await row(`SELECT count(*)::int AS n FROM public.rounds WHERE room_id = $1`, [rid]);
  check(`${L} INSERT direto em rounds (anular pontuação) bloqueado`, rr.n === 0, r.error?.code);

  for (const [table, payload] of [
    ["room_words", { room_id: rid, word: "x", meaning: "y" }],
    ["room_messages", { room_id: rid, player_id: EVE, text: "spam" }],
    ["reactions", { room_id: rid, player_id: EVE, emoji: "💩" }],
    ["votes", { room_id: rid, round: 1, voter_id: EVE, definition_id: rid }],
    ["round_extensions", { room_id: rid, round: 1, player_id: BOB, attempt: 1 }],
  ]) {
    r = await actor.c.from(table).insert(payload);
    check(`${L} INSERT direto em ${table} bloqueado`, !!r.error, r.error?.code);
  }
}

console.log("\n— Significado de palavra customizada (antes da revelação)");
const { id: cwid } = await row(
  `INSERT INTO public.room_words (room_id, word, meaning, category, created_by)
   VALUES ($1, 'zimbrar', 'segredo do teste', 'custom', $2) RETURNING id`,
  [rid, ALICE],
);
for (const actor of [anon, E]) {
  const leak = await actor.c.from("room_words").select("meaning").eq("room_id", rid);
  check(
    `[${actor.label}] SELECT room_words.meaning bloqueado`,
    !!leak.error || !(leak.data ?? []).some((w) => w.meaning),
    leak.error?.code,
  );
  const ok = await actor.c.from("room_words").select("id,word,category").eq("room_id", rid);
  check(`[${actor.label}] colunas não-reveladoras seguem legíveis`, ok.data?.[0]?.word === "zimbrar", ok.error?.code);
}

console.log("\n— RPCs internas fechadas");
for (const actor of [anon, E]) {
  const r1 = await actor.c.rpc("apply_similarity_bonus", {
    p_room_id: rid, p_round: 1, p_definition_ids: [],
  });
  const r2 = await actor.c.rpc("apply_similarity_bonus", { p_definition_ids: [] });
  check(`[${actor.label}] apply_similarity_bonus (ambas as assinaturas) negado`, !!r1.error && !!r2.error, `${r1.error?.code}/${r2.error?.code}`);
  const r3 = await actor.c.rpc("insert_truth_definition", { p_room_id: rid, p_round: 1, p_text: "verdade plantada" });
  check(`[${actor.label}] insert_truth_definition (plantar verdade) negado`, !!r3.error, r3.error?.code);
  const r4 = await actor.c.rpc("tick_stalled_rooms");
  check(`[${actor.label}] tick_stalled_rooms negado`, !!r4.error, r4.error?.code);
}

console.log("\n— Ações em nome de outro jogador");
{
  let r = await M.c.rpc("add_bot", {
    p_room_id: rid, p_actor_id: BOB, p_bot_id: `bot_${tag}x`, p_nickname: "Intruso", p_avatar: "x", p_color: "#000",
  });
  check("add_bot por quem é de fora (fingindo ser Bob) recusado", r.data?.reason === "identity_mismatch", short(r.data ?? r.error?.message));
  r = await anon.c.rpc("add_bot", {
    p_room_id: rid, p_actor_id: BOB, p_bot_id: `bot_${tag}y`, p_nickname: "Intruso", p_avatar: "x", p_color: "#000",
  });
  check("add_bot sem sessão recusado", r.data?.reason === "session_required", short(r.data ?? r.error?.message));
  r = await B.c.rpc("add_bot", {
    p_room_id: rid, p_actor_id: BOB, p_bot_id: BOT1, p_nickname: "TioBlefe", p_avatar: "🤖", p_color: "#abc",
  });
  check("add_bot por jogador não-host da sala (regra atual) funciona", r.data?.ok === true, short(r.data ?? r.error?.message));
  r = await A.c.rpc("add_bot", {
    p_room_id: rid, p_actor_id: ALICE, p_bot_id: BOT2, p_nickname: "Vó Vera", p_avatar: "🤖", p_color: "#def",
  });
  check("add_bot pelo host funciona", r.data?.ok === true, short(r.data ?? r.error?.message));
  r = await A.c.rpc("add_bot", {
    p_room_id: rid, p_actor_id: ALICE, p_bot_id: "nao-e-bot", p_nickname: "X", p_avatar: "x", p_color: "#000",
  });
  check("add_bot com id inválido recusado", r.data?.reason === "invalid_bot_id", short(r.data));

  r = await E.c.rpc("leave_room", { p_player_id: BOB });
  let bob = await row(`SELECT 1 AS x FROM public.players WHERE id = $1 AND room_id = $2`, [BOB, rid]);
  check("leave_room de outro jogador (Eve tirando Bob) recusado", r.data?.reason === "identity_mismatch" && !!bob, short(r.data));
  r = await anon.c.rpc("leave_room", { p_player_id: BOB });
  bob = await row(`SELECT 1 AS x FROM public.players WHERE id = $1 AND room_id = $2`, [BOB, rid]);
  check("leave_room sem sessão recusado", r.data?.reason === "session_required" && !!bob, short(r.data));

  r = await E.c.rpc("join_public_room", { p_player_id: BOB, p_nickname: "Bob", p_avatar: "x", p_color: "#000" });
  bob = await row(`SELECT room_id FROM public.players WHERE id = $1`, [BOB]);
  check(
    "join_public_room com o id de Bob (tirar da sala/zerar placar) recusado",
    /player_id_taken/.test(r.error?.message ?? "") && bob.room_id === rid,
    r.error?.message,
  );

  r = await E.c.rpc("migrate_host", { p_room_id: rid });
  const host = await row(`SELECT host_id FROM public.rooms WHERE id = $1`, [rid]);
  check("migrate_host com o host presente não muda nada", r.data?.changed === false && host.host_id === ALICE, short(r.data));

  r = await E.c.rpc("host_update_room_config", { p_room_id: rid, p_actor_id: ALICE, p_patch: { win_target: 1 } });
  check("configurar sala fingindo ser o host recusado", r.data?.reason === "identity_mismatch", short(r.data));
  r = await A.c.rpc("host_update_room_config", {
    p_room_id: rid, p_actor_id: ALICE, p_patch: { win_condition: "rounds", win_target: 2 },
  });
  check("host configura 2 rodadas", r.data?.ok === true, short(r.data));
}

// ---------------------------------------------------------------------------
console.log("\n— Partida legítima completa (2 rodadas)");
const status = async () => (await row(`SELECT status, current_round FROM public.rooms WHERE id = $1`, [rid]));
const holdDeadline = () =>
  db.query(`UPDATE public.rooms SET round_phase_ends_at = now() + interval '10 minutes' WHERE id = $1`, [rid]);
const scoreOf = async () =>
  Object.fromEntries(
    (await rows(`SELECT id, score, coordinator_count FROM public.players WHERE room_id = $1`, [rid])).map((p) => [
      p.id,
      p.score,
    ]),
  );

{
  let r = await E.c.rpc("start_game", { p_room_id: rid });
  check("start_game por não-host recusado", r.data?.reason === "not_authorized", short(r.data));
  r = await A.c.rpc("start_game", { p_room_id: rid });
  check("host inicia a partida", r.data?.ok === true, short(r.data));
}
await db.query(`UPDATE public.rooms SET current_coordinator = $2 WHERE id = $1`, [rid, ALICE]);
await holdDeadline();

// Rodada 1 com a palavra customizada (exercita o caminho room_words)
{
  const r = await A.c.rpc("choose_word", { p_room_id: rid, p_word_id: cwid, p_duration_sec: 60 });
  check("coordenadora escolhe a palavra", r.data?.ok === true, short(r.data));
  await holdDeadline();
  const st = await B.c.rpc("get_room_state", { p_code: room.code });
  check(
    "durante a escrita o estado da sala NÃO traz o significado",
    st.data?.word?.word === "zimbrar" && st.data?.word?.meaning === undefined,
    short(st.data?.word),
  );
}
{
  let r = await B.c.rpc("submit_definition", { p_room_id: rid, p_player_id: BOB, p_text: "fruta azeda do cerrado" });
  check("Bob envia definição", r.data?.ok === true, short(r.data));
  r = await E.c.rpc("submit_definition", { p_room_id: rid, p_player_id: EVE, p_text: "ferramenta de sapateiro antiga" });
  check("Eve envia definição", r.data?.ok === true, short(r.data));
  r = await E.c.rpc("submit_definition", { p_room_id: rid, p_player_id: BOB, p_text: "texto forjado pela eve" });
  check("Eve reescrevendo a definição de Bob recusado", r.data?.reason === "identity_mismatch", short(r.data));
  r = await anon.c.rpc("submit_definition", { p_room_id: rid, p_player_id: BOB, p_text: "texto forjado sem sessao" });
  check("reescrever definição alheia sem sessão recusado", r.data?.reason === "session_required", short(r.data));
  const bobDef = await row(`SELECT text FROM public.definitions WHERE room_id = $1 AND player_id = $2`, [rid, BOB]);
  check("definição de Bob intacta", bobDef?.text === "fruta azeda do cerrado", bobDef?.text);

  r = await E.c.rpc("submit_bot_definitions_bulk", {
    p_room_id: rid, p_round: 1, p_rows: [{ player_id: BOT1, text: "texto do bot escrito pela eve" }],
  });
  check("escrever pelos bots sem ser o host recusado", r.data?.reason === "not_authorized", short(r.data));
  r = await A.c.rpc("submit_bot_definitions_bulk", {
    p_room_id: rid, p_round: 1,
    p_rows: [
      { player_id: BOT1, text: "danca tipica do litoral norte" },
      { player_id: BOT2, text: "tecido grosso de algodao cru" },
    ],
  });
  check("host envia as definições dos bots", r.data?.inserted === 2, short(r.data));

  const n0 = (await row(`SELECT count(*)::int AS n FROM public.definitions WHERE room_id = $1`, [rid])).n;
  for (const actor of [anon, E]) {
    await actor.c.from("definitions").update({ text: "hackeado", is_truth: true }).eq("room_id", rid);
    await actor.c.from("definitions").delete().eq("room_id", rid);
  }
  const hacked = await row(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE text = 'hackeado' OR is_truth)::int AS bad
     FROM public.definitions WHERE room_id = $1`,
    [rid],
  );
  check("PATCH/DELETE direto em definitions não altera nada", hacked.n === n0 && hacked.bad === 0, short(hacked));
}
{
  let r = await B.c.rpc("start_shuffling", { p_room_id: rid });
  check("todos escreveram: start_shuffling ok", r.data?.ok === true, short(r.data));
  r = await B.c.rpc("advance_writing_to_voting", { p_room_id: rid });
  check("abre a votação", (await status()).status === "voting", (await status()).status);
  await holdDeadline();
  const truth = await row(
    `SELECT text FROM public.definitions WHERE room_id = $1 AND round = 1 AND is_truth`,
    [rid],
  );
  check("a verdade foi inserida PELO SERVIDOR a partir do significado", truth?.text === "segredo do teste", truth?.text);
}
const defs = await rows(`SELECT id, player_id FROM public.definitions WHERE room_id = $1 AND round = 1`, [rid]);
const d = Object.fromEntries(defs.map((x) => [x.player_id, x.id]));
{
  let r = await B.c.rpc("cast_vote", { p_room_id: rid, p_voter_id: BOB, p_definition_id: d.__truth__ });
  check("Bob vota (na verdade)", r.data?.ok === true, short(r.data));
  r = await E.c.rpc("cast_vote", { p_room_id: rid, p_voter_id: EVE, p_definition_id: d[BOB] });
  check("Eve vota (no blefe de Bob)", r.data?.ok === true, short(r.data));
  r = await A.c.rpc("cast_vote", { p_room_id: rid, p_voter_id: ALICE, p_definition_id: d[EVE] });
  check("Alice (coordenadora) vota (no blefe de Eve)", r.data?.ok === true, short(r.data));
  r = await E.c.rpc("cast_vote", { p_room_id: rid, p_voter_id: BOB, p_definition_id: d[EVE] });
  check("Eve trocando o voto de Bob recusado", r.data?.reason === "identity_mismatch", short(r.data));
  r = await anon.c.rpc("cast_vote", { p_room_id: rid, p_voter_id: BOB, p_definition_id: d[EVE] });
  check("trocar voto alheio sem sessão recusado", r.data?.reason === "session_required", short(r.data));
  const bobVote = await row(`SELECT definition_id FROM public.votes WHERE room_id = $1 AND voter_id = $2`, [rid, BOB]);
  check("voto de Bob intacto", bobVote?.definition_id === d.__truth__);

  r = await E.c.rpc("cast_votes_bulk", {
    p_room_id: rid, p_round: 1,
    p_votes: [
      { voter_id: BOT1, definition_id: d[EVE] },
      { voter_id: BOT2, definition_id: d[EVE] },
    ],
  });
  check("fazer os bots votarem no próprio blefe sem ser o host recusado", r.data?.reason === "not_authorized", short(r.data));
  r = await A.c.rpc("cast_votes_bulk", {
    p_room_id: rid, p_round: 1,
    p_votes: [
      { voter_id: BOT1, definition_id: d.__truth__ },
      { voter_id: BOT2, definition_id: d[BOB] },
    ],
  });
  check("host registra os votos dos bots", r.data?.inserted === 2, short(r.data));
}
{
  await A.c.rpc("advance_voting_to_reveal", { p_room_id: rid });
  check("revela", (await status()).status === "reveal", (await status()).status);
  const S = await scoreOf();
  // Pontuação ORIGINAL: +3 verdade, +1 por voto recebido, +2 coordenador só
  // se ninguém acha a verdade.
  check("Bob = 5 (+3 verdade, +1 Eve, +1 bot)", S[BOB] === 5, `bob=${S[BOB]}`);
  check("Eve = 1 (+1 Alice)", S[EVE] === 1, `eve=${S[EVE]}`);
  check("Alice (coordenadora) = 0 (a verdade foi achada)", S[ALICE] === 0, `alice=${S[ALICE]}`);
  check("bot1 = 3 (+3 verdade)", S[BOT1] === 3, `bot1=${S[BOT1]}`);
  check("bot2 = 0", S[BOT2] === 0, `bot2=${S[BOT2]}`);
  const rev = await B.c.rpc("get_word_reveal", { p_room_id: rid });
  check("na revelação o significado da palavra customizada aparece", rev.data?.meaning === "segredo do teste", short(rev.data));
  const r = await A.c.rpc("finish_reveal", { p_room_id: rid });
  check("placar da rodada", r.data?.status === "scoreboard", short(r.data));
}

// Rodada 2 com palavra do banco global
{
  const r = await A.c.rpc("advance_scoreboard_to_next_round_or_finished", { p_room_id: rid, p_force: true });
  check("próxima rodada", r.data?.action === "next_round", short(r.data));
}
await db.query(`UPDATE public.rooms SET current_coordinator = $2 WHERE id = $1`, [rid, BOB]);
await holdDeadline();
{
  const { id: gw } = await row(`SELECT id FROM public.words WHERE meaning IS NOT NULL LIMIT 1`);
  let r = await B.c.rpc("choose_word", { p_room_id: rid, p_word_id: gw, p_duration_sec: 60 });
  check("rodada 2: palavra escolhida", r.data?.ok === true, short(r.data));
  await holdDeadline();
  r = await A.c.rpc("submit_definition", { p_room_id: rid, p_player_id: ALICE, p_text: "instrumento de corda nordestino" });
  check("rodada 2: Alice escreve", r.data?.ok === true, short(r.data));
  r = await E.c.rpc("submit_definition", { p_room_id: rid, p_player_id: EVE, p_text: "doce de leite com coco queimado" });
  check("rodada 2: Eve escreve", r.data?.ok === true, short(r.data));
  r = await A.c.rpc("start_shuffling", { p_room_id: rid });
  await A.c.rpc("advance_writing_to_voting", { p_room_id: rid });
  check("rodada 2: votação aberta", (await status()).status === "voting", (await status()).status);
  await holdDeadline();
  const d2 = Object.fromEntries(
    (await rows(`SELECT id, player_id FROM public.definitions WHERE room_id = $1 AND round = 2`, [rid])).map((x) => [
      x.player_id,
      x.id,
    ]),
  );
  await A.c.rpc("cast_vote", { p_room_id: rid, p_voter_id: ALICE, p_definition_id: d2.__truth__ });
  await E.c.rpc("cast_vote", { p_room_id: rid, p_voter_id: EVE, p_definition_id: d2[ALICE] });
  await B.c.rpc("cast_vote", { p_room_id: rid, p_voter_id: BOB, p_definition_id: d2[EVE] });
  await A.c.rpc("advance_voting_to_reveal", { p_room_id: rid });
  const S = await scoreOf();
  check("rodada 2 pontuada: Alice 4, Eve 2, Bob 5", S[ALICE] === 4 && S[EVE] === 2 && S[BOB] === 5, short(S));
  await A.c.rpc("finish_reveal", { p_room_id: rid });
  const fin = await A.c.rpc("advance_scoreboard_to_next_round_or_finished", { p_room_id: rid, p_force: true });
  check("2 rodadas jogadas: partida encerrada", fin.data?.action === "finished", short(fin.data));
}

console.log("\n— XP: registro único mesmo com chamadas paralelas (SCORE-05)");
{
  const r = await B.c.rpc("record_match_result", { p_room_code: room.code });
  check("Bob registra o resultado (XP)", r.data?.ok === true && r.data?.xp_gained > 0, short(r.data));
  const both = await Promise.all([
    E.c.rpc("record_match_result", { p_room_code: room.code }),
    E.c.rpc("record_match_result", { p_room_code: room.code }),
  ]);
  const gained = both.filter((x) => (x.data?.xp_gained ?? 0) > 0).length;
  const mh = await row(
    `SELECT count(*)::int AS n FROM public.match_history WHERE user_id = $1 AND room_code = $2`,
    [E.uid, room.code],
  );
  check("2 chamadas simultâneas de Eve: XP somado uma única vez", gained === 1 && mh.n === 1, `gained=${gained} history=${mh.n}`);
  const anonR = await anon.c.rpc("record_match_result", { p_room_code: room.code });
  check("registrar resultado sem sessão recusado", !!anonR.error, anonR.error?.message);
}

console.log("\n— Revanche e migração de host");
{
  let r = await E.c.rpc("reset_room", { p_room_id: rid });
  check("revanche por não-host recusada", !!r.error, r.error?.message);
  r = await A.c.rpc("reset_room", { p_room_id: rid });
  const st = await status();
  const S = await scoreOf();
  check(
    "revanche pelo host: sala volta ao lobby com placar zerado",
    !r.error && st.status === "lobby" && Object.values(S).every((v) => v === 0),
    `${st.status} ${short(S)}`,
  );
  r = await A.c.rpc("start_game", { p_room_id: rid });
  check("revanche: nova partida inicia", r.data?.ok === true, short(r.data));
  await A.c.rpc("reset_room", { p_room_id: rid });

  r = await A.c.rpc("leave_room", { p_player_id: ALICE });
  check("host sai do lobby", r.data?.ok === true, short(r.data));
  r = await B.c.rpc("migrate_host", { p_room_id: rid });
  const host = await row(`SELECT host_id FROM public.rooms WHERE id = $1`, [rid]);
  check("herdeiro (humano mais antigo: Bob) vira host — calculado no servidor", host.host_id === BOB, short(r.data));
  r = await B.c.rpc("kick_player", { p_room_id: rid, p_actor_id: BOB, p_target_player_id: EVE });
  check("novo host expulsa jogador", r.data?.ok === true, short(r.data));
}

// ---------------------------------------------------------------------------
console.log("\n— Privilégios efetivos no banco");
const GAME_TABLES = [
  "players", "definitions", "votes", "rounds", "round_extensions",
  "rooms", "room_words", "reactions", "room_messages", "words",
];
const writable = await rows(
  `SELECT r.role, t.tbl, p.priv
     FROM unnest(ARRAY['anon','authenticated']) r(role)
     CROSS JOIN unnest($1::text[]) t(tbl)
     CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p(priv)
    WHERE has_table_privilege(r.role, 'public.' || t.tbl, p.priv)`,
  [GAME_TABLES],
);
check("nenhuma escrita direta para anon/authenticated nas tabelas de jogo", writable.length === 0, short(writable));
const colGrants = await row(
  `SELECT has_column_privilege('anon','public.room_words','meaning','SELECT') AS meaning_anon,
          has_column_privilege('authenticated','public.room_words','meaning','SELECT') AS meaning_auth,
          has_column_privilege('anon','public.room_words','word','SELECT') AS word_anon`,
);
check(
  "room_words.meaning ilegível; word legível",
  !colGrants.meaning_anon && !colGrants.meaning_auth && colGrants.word_anon,
  short(colGrants),
);

const DENY = [
  "apply_similarity_bonus", "tick_stalled_rooms", "cleanup_zombie_rooms", "advance_choosing_to_writing",
  "advance_reveal_to_scoreboard", "get_app_config", "assert_actor_identity", "guard_author_identity",
  "guard_no_self_vote", "guard_writing_phase_advance", "handle_new_user", "get_random_words",
  "submit_daily_attempt", "submit_daily_attempt_scored", "insert_truth_definition",
  "is_sessionless_api_call", "ops_health_check",
];
const ALLOW_ANON = [
  "add_bot", "admin_list_words", "admin_ops_recent", "admin_ops_summary", "admin_review_word",
  "advance_scoreboard_to_next_round_or_finished", "advance_voting_to_reveal", "advance_writing_to_voting",
  "assign_player_team", "cast_vote", "cast_votes_bulk", "choose_word", "claim_player_identity",
  "create_room_with_host", "extend_voting_or_advance", "extend_writing_or_advance", "finish_reveal",
  "get_ballot", "get_client_config", "get_or_create_daily_challenge", "get_random_word_prompts",
  "get_ranking_top", "get_room_definitions", "get_room_reveal", "get_room_state", "get_round_reveal",
  "get_round_sync", "get_word_reveal", "has_role", "host_update_room_config", "is_player_banned",
  "join_public_room", "kick_player", "leave_room", "log_ops_event", "migrate_host", "phase_secs",
  "record_match_result", "rejoin_room", "reset_room", "send_reaction", "send_room_message", "start_game",
  "start_shuffling", "submit_bot_definitions_bulk", "submit_definition", "xp_to_level",
];
const execRows = await rows(
  `SELECT DISTINCT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend dp WHERE dp.objid = p.oid AND dp.deptype = 'e')`,
);
const leaked = execRows.filter((x) => DENY.includes(x.proname) && (x.anon_x || x.auth_x)).map((x) => x.proname);
check("funções internas NÃO executáveis por anon/authenticated", leaked.length === 0, leaked.join(", "));
const anonExec = execRows.filter((x) => x.anon_x).map((x) => x.proname);
const unexpected = anonExec.filter((n) => !ALLOW_ANON.includes(n));
check(
  "allowlist: nenhuma função nova exposta a anon sem decisão explícita",
  unexpected.length === 0,
  unexpected.length ? `não esperadas: ${unexpected.join(", ")}` : `${anonExec.length} expostas, todas previstas`,
);

// ---------------------------------------------------------------------------
for (const id of createdRooms) await db.query(`DELETE FROM public.rooms WHERE id = $1`, [id]);
await db.query(`DELETE FROM public.players WHERE id LIKE $1 OR id LIKE $2`, [`sec_%_${tag}`, `bot_${tag}%`]);
await db.query(`DELETE FROM public.match_history WHERE room_code = $1`, [room.code]);
await db.end();
console.log(fails ? `\n${fails}/${total} FALHAS` : `\nSEGURANÇA REST OK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
