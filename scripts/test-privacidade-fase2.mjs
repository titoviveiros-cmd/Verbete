// Privacidade das salas — fase 2 (migration 20261112120000, 12/11/2026)
// pela API PÚBLICA real (PostgREST + Realtime do Supabase local da CI):
//   * enumeração: sem sessão e sessão de fora NÃO leem players, votes,
//     reactions, round_extensions, rounds, room_messages, room_words da sala
//     (listagem, filtro amplo, por room_id, contagem exata, embutir);
//   * as 6 RPCs de leitura por id: de fora = sala inexistente;
//   * participante e expulso leem; service_role inalterado;
//   * Realtime REAL: postgres_changes só para participante; canal PRIVADO
//     room:<id> só para participante (broadcast e presença); o tópico público
//     de mesmo nome não recebe o tráfego privado; latency:<uid> só do dono;
//     assinar ANTES de entrar → recusado e liga sozinho depois da entrada;
//     reconexão; entradas simultâneas;
//   * fluxo do app antigo (vc8: canal público + leituras por room_id).
// Envs: SUPA_URL, ANON, DB_URL. Grava só salas de teste (apagadas no fim).
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const { SUPA_URL, ANON, DB_URL } = process.env;
if (!SUPA_URL || !ANON || !DB_URL) {
  console.error("✖ SUPA_URL, ANON e DB_URL são obrigatórios (Supabase local).");
  process.exit(1);
}
const host = new URL(DB_URL).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  console.error(`✖ recusado: DB_URL aponta para "${host}". Este teste grava e só roda em banco LOCAL.`);
  process.exit(1);
}
const db = new pg.Client({ connectionString: DB_URL });
await db.connect();

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
};
const short = (x) => JSON.stringify(x ?? null).slice(0, 160);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TABLES = ["players", "votes", "reactions", "round_extensions", "rounds", "room_messages", "room_words"];
const SEL = { room_words: "id,room_id,word" };

const newClient = () =>
  createClient(SUPA_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
const clients = [];
async function withSession(label) {
  const c = newClient();
  clients.push(c);
  const { data, error } = await c.auth.signInAnonymously();
  if (error || !data.session) throw new Error(`sessão anônima (${label}) falhou: ${error?.message}`);
  try {
    await c.realtime.setAuth(data.session.access_token);
  } catch {
    /* versões antigas: o cliente já repassa o token sozinho */
  }
  return { c, uid: data.user.id, token: data.session.access_token, label };
}
// Assina e espera o 1º estado final (SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT).
function subscribe(ch, ms = 12000) {
  return new Promise((resolve) => {
    const log = [];
    const t = setTimeout(() => resolve({ status: "SEM_RESPOSTA", log }), ms);
    ch.subscribe((s, err) => {
      log.push(s + (err ? `:${String(err.message ?? err).slice(0, 80)}` : ""));
      if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
        clearTimeout(t);
        resolve({ status: s, log });
      }
    });
  });
}

const tag = Math.random().toString(36).slice(2, 8);
const anon = { c: newClient(), label: "sem sessão" };
clients.push(anon.c);
const A = await withSession("Ana/host");
const B = await withSession("Beto/convidado");
const K = await withSession("Kai/expulso");
const M = await withSession("Mallory/de fora (host de outra sala)");
const createdRooms = [];

// --------------------------------------------------------------------------
console.log("\n— Preparação: duas salas reais (criar + entrar pelas RPCs) e conteúdo de partida");
const mkRoom = async (who, pid, nick) => {
  const { data, error } = await who.c.rpc("create_room_with_host", { p_host_id: pid, p_nickname: nick, p_avatar: "a", p_color: "#111" });
  if (error || !data?.id) {
    console.error("✖ não criou a sala de teste:", error?.message);
    process.exit(1);
  }
  createdRooms.push(data.id);
  return data;
};
const room = await mkRoom(A, `pf_a_${tag}`, "Ana");
const other = await mkRoom(M, `pf_m_${tag}`, "Mal");
for (const [who, pid] of [[B, `pf_b_${tag}`], [K, `pf_k_${tag}`]]) {
  const { data, error } = await who.c.rpc("rejoin_room", { p_code: room.code, p_player_id: pid, p_nickname: who.label.split("/")[0], p_avatar: "b", p_color: "#222" });
  check(`${who.label} entra pelo código`, !error && data?.id === room.id, short(error?.message ?? data?.code));
}
await db.query(`UPDATE public.players SET kicked_at = now() WHERE id = $1`, [`pf_k_${tag}`]);
const { rows: [w] } = await db.query(`SELECT id FROM public.words ORDER BY id LIMIT 1`);
for (const [r, p] of [[room, `pf_a_${tag}`], [other, `pf_m_${tag}`]]) {
  await db.query(`UPDATE public.rooms SET status = 'reveal', current_round = 1, current_word_id = $2 WHERE id = $1`, [r.id, w.id]);
  await db.query(`INSERT INTO public.room_words (room_id, word, meaning, category) VALUES ($1, 'palavrinha', 'segredo', 'custom')`, [r.id]);
  await db.query(`INSERT INTO public.definitions (room_id, round, player_id, text, letter, is_truth) VALUES ($1, 1, $2, 'uma definicao', 'A', false)`, [r.id, p]);
  const { rows: [d] } = await db.query(`INSERT INTO public.definitions (room_id, round, player_id, text, letter, is_truth) VALUES ($1, 1, '__truth__', 'a verdade', 'B', true) RETURNING id`, [r.id]);
  await db.query(`INSERT INTO public.votes (room_id, round, voter_id, definition_id) VALUES ($1, 1, $2, $3)`, [r.id, p, d.id]);
  await db.query(`INSERT INTO public.reactions (room_id, player_id, emoji) VALUES ($1, $2, 'x')`, [r.id, p]);
  await db.query(`INSERT INTO public.round_extensions (room_id, round, player_id, attempt) VALUES ($1, 1, $2, 1)`, [r.id, p]);
  await db.query(`INSERT INTO public.rounds (room_id, round, coordinator_id) VALUES ($1, 1, $2)`, [r.id, p]);
  await db.query(`INSERT INTO public.room_messages (room_id, player_id, text) VALUES ($1, $2, 'oi')`, [r.id, p]);
}
const inRoom = {};
for (const t of TABLES) inRoom[t] = Number((await db.query(`SELECT count(*) FROM public.${t} WHERE room_id = $1`, [room.id])).rows[0].count);
const inOther = {};
for (const t of TABLES) inOther[t] = Number((await db.query(`SELECT count(*) FROM public.${t} WHERE room_id = $1`, [other.id])).rows[0].count);

// --------------------------------------------------------------------------
console.log("\n— Enumeração pela REST (PostgREST real)");
{
  const raw = await fetch(`${SUPA_URL}/rest/v1/players?select=nickname,user_id,room_id`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, Prefer: "count=exact" },
  });
  const body = await raw.json().catch(() => null);
  check(
    "GET /rest/v1/players?select=nickname,user_id,room_id SEM sessão → 0 linhas ou 401/403",
    (raw.status === 200 && Array.isArray(body) && body.length === 0) || [401, 403].includes(raw.status),
    `HTTP ${raw.status} · Content-Range ${raw.headers.get("content-range")} · ${short(body)}`,
  );
}
for (const [who, label, own] of [[anon, "sem sessão", null], [M, "sessão de fora", other.id]]) {
  for (const t of TABLES) {
    const sel = SEL[t] ?? "*";
    const all = await who.c.from(t).select(sel);
    const byId = await who.c.from(t).select(sel).eq("room_id", room.id);
    const amplo = await who.c.from(t).select(sel).neq("room_id", "00000000-0000-0000-0000-000000000000");
    // Contagem com as MESMAS colunas legíveis (room_words só tem GRANT por
    // coluna, sem `meaning`: "select=*" é negado com 42501 desde o master —
    // ver a checagem própria logo abaixo).
    const { count, error: cErr } = await who.c.from(t).select(sel, { count: "exact", head: true });
    const exp = own ? inOther[t] : 0;
    const okOwn = (r) => !r.error && (r.data ?? []).length === exp && (r.data ?? []).every((x) => x.room_id === own);
    check(
      `${label}: ${t} → listagem ${all.data?.length ?? all.error?.code}, filtro amplo ${amplo.data?.length ?? amplo.error?.code}, room_id da sala ${byId.data?.length ?? byId.error?.code}, contagem ${count ?? cErr?.code} (esperado ${exp}/${exp}/0/${exp})`,
      okOwn(all) && okOwn(amplo) && !byId.error && byId.data.length === 0 && !cErr && count === exp,
    );
  }
  // room_words.meaning (o significado da palavra customizada) continua fora de
  // alcance por GRANT de coluna: "select=*" e "select=meaning" → 42501.
  for (const s of ["*", "meaning"]) {
    const r = await who.c.from("room_words").select(s, { count: "exact" }).eq("room_id", room.id);
    check(`${label}: room_words?select=${s} → negado (42501), sem linhas`, r.error?.code === "42501" && !r.data?.length, short(r.error?.code ?? r.data));
  }
  const emb = await who.c.from("rooms").select("id, players(nickname,user_id)").eq("id", room.id);
  check(`${label}: rooms?select=players(…) da sala → nada`, !emb.error && (emb.data ?? []).length === 0, short(emb.error?.message ?? emb.data));
}

// --------------------------------------------------------------------------
console.log("\n— Participantes (inclusive expulso) leem a própria sala; service_role inalterado");
for (const [who, label] of [[A, "host"], [B, "convidado"], [K, "expulso"]]) {
  const res = [];
  for (const t of TABLES) {
    const r = await who.c.from(t).select(SEL[t] ?? "*").eq("room_id", room.id);
    const o = await who.c.from(t).select(SEL[t] ?? "*").eq("room_id", other.id);
    res.push([t, r.data?.length ?? r.error?.code, inRoom[t], o.data?.length ?? o.error?.code]);
  }
  check(`${label} lê as 7 tabelas da sala e 0 da outra`, res.every(([, a, e, o]) => a === e && o === 0), short(res));
}

// --------------------------------------------------------------------------
console.log("\n— RPCs de leitura por id");
{
  const fakeId = "00000000-0000-4000-8000-00000000f00d";
  const calls = [
    ["get_round_sync", { p_room_id: room.id }, { p_room_id: fakeId }],
    ["get_ballot", { p_room_id: room.id }, { p_room_id: fakeId }],
    ["get_room_definitions", { p_room_id: room.id }, { p_room_id: fakeId }],
    ["get_room_reveal", { p_room_id: room.id }, { p_room_id: fakeId }],
    ["get_round_reveal", { p_room_id: room.id, p_round: 1 }, { p_room_id: fakeId, p_round: 1 }],
    ["get_word_reveal", { p_room_id: room.id }, { p_room_id: fakeId }],
  ];
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (const [fn, args, fake] of calls) {
    const g = await B.c.rpc(fn, args);
    const k = await K.c.rpc(fn, args);
    const nada = await B.c.rpc(fn, fake);
    const m = await M.c.rpc(fn, args);
    const a = await anon.c.rpc(fn, args);
    check(`${fn}: participante e expulso recebem a partida`, !g.error && eq(g.data, k.data) && !eq(g.data, nada.data), short(g.error?.message ?? g.data));
    check(`${fn}: de fora e sem sessão = sala inexistente`, !m.error && !a.error && eq(m.data, nada.data) && eq(a.data, nada.data), short([m.error?.message ?? m.data, a.error?.message ?? a.data]));
  }
  const st = await B.c.rpc("get_room_state", { p_code: room.code });
  check("get_room_state participante: completo (definições e palavra revelada vêm das RPCs guardadas)", st.data?.definitions?.length === 2 && !!st.data?.word?.meaning, short([st.data?.definitions?.length, !!st.data?.word]));
}

// --------------------------------------------------------------------------
console.log("\n— Realtime postgres_changes (canal público, como o vc8): só participante recebe");
{
  const got = { B: 0, M: 0, anon: 0 };
  const subs = [];
  for (const [key, who] of [["B", B], ["M", M], ["anon", anon]]) {
    const ch = who.c.channel(`pf-pg-${key}-${tag}`);
    for (const t of ["players", "votes", "reactions", "round_extensions"])
      ch.on("postgres_changes", { event: "*", schema: "public", table: t, filter: `room_id=eq.${room.id}` }, () => {
        got[key]++;
      });
    subs.push([who, ch, await subscribe(ch)]);
  }
  await sleep(2000);
  for (let i = 0; i < 6 && got.B === 0; i++) {
    await db.query(`UPDATE public.players SET score = score + 1 WHERE id = $1`, [`pf_a_${tag}`]);
    await db.query(`INSERT INTO public.reactions (room_id, player_id, emoji) VALUES ($1, $2, 'y')`, [room.id, `pf_a_${tag}`]);
    for (let t = 0; t < 10 && got.B === 0; t++) await sleep(250);
  }
  await sleep(1500);
  check("participante RECEBE as mudanças de players/reactions", got.B > 0, `${short(subs.map((s) => s[2].status))} ${short(got)}`);
  check("sessão de fora NÃO recebe", got.M === 0, short(got));
  check("sem sessão NÃO recebe", got.anon === 0, short(got));
  for (const [who, ch] of subs) await who.c.removeChannel(ch);
}

// --------------------------------------------------------------------------
console.log("\n— Canal PRIVADO room:<id> (Realtime Authorization)");
{
  const topic = `room:${room.id}`;
  const recv = { B: [], M: [], pub: [] };
  // Mesma configuração do app (use-room-realtime.ts): chave de presença + um
  // ouvinte "presence sync". Sem ouvinte de presença, o realtime-js assina com
  // presence.enabled=false e o servidor não liga a presença no canal.
  const sync = { A: 0 };
  const chA = A.c
    .channel(topic, { config: { private: true, presence: { key: `pf_a_${tag}` } } })
    .on("presence", { event: "sync" }, () => sync.A++);
  const chB = B.c
    .channel(topic, { config: { private: true, presence: { key: `pf_b_${tag}` } } })
    .on("presence", { event: "sync" }, () => {})
    .on("broadcast", { event: "room-sync" }, (p) => recv.B.push(p.payload));
  const sA = await subscribe(chA);
  const sB = await subscribe(chB);
  check("participantes (host e convidado) assinam o canal privado", sA.status === "SUBSCRIBED" && sB.status === "SUBSCRIBED", short([sA.log, sB.log]));
  const chM = M.c.channel(topic, { config: { private: true } }).on("broadcast", { event: "room-sync" }, (p) => recv.M.push(p.payload));
  const sM = await subscribe(chM);
  check("sessão de fora é RECUSADA no canal privado", sM.status !== "SUBSCRIBED", short(sM.log));
  await M.c.removeChannel(chM);
  const chN = anon.c.channel(topic, { config: { private: true } });
  const sN = await subscribe(chN);
  check("sem sessão é RECUSADO no canal privado", sN.status !== "SUBSCRIBED", short(sN.log));
  await anon.c.removeChannel(chN);
  // o tópico PÚBLICO de mesmo nome (o do vc8) não recebe o tráfego privado
  const chP = M.c.channel(topic).on("broadcast", { event: "room-sync" }, (p) => recv.pub.push(p.payload));
  const sP = await subscribe(chP);
  await sleep(500);
  const sent = await chA.send({ type: "broadcast", event: "room-sync", payload: { sig: `t-${tag}` } });
  for (let i = 0; i < 20 && recv.B.length === 0; i++) await sleep(250);
  await sleep(800);
  check("broadcast no canal privado: o participante recebe", sent === "ok" && recv.B.length === 1, `${sent} ${short(recv.B)}`);
  check("o tópico PÚBLICO room:<id> (vc8) não recebe o tráfego privado", sP.status === "SUBSCRIBED" && recv.pub.length === 0, `${sP.status} ${short(recv.pub)}`);
  await M.c.removeChannel(chP);
  const tracked = await chB.track({ player_id: `pf_b_${tag}` });
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    seen = Object.keys(chA.presenceState()).includes(`pf_b_${tag}`);
    if (!seen) await sleep(250);
  }
  check("presença: o convidado publica (track ok) e o host o vê no canal privado", tracked === "ok" && seen, `track=${tracked} syncs=${sync.A} ${short(Object.keys(chA.presenceState()))}`);
  // e quem está fora não vê essa presença pelo tópico público de mesmo nome
  {
    const chQ = M.c.channel(topic, { config: { presence: { key: `pf_m_${tag}` } } }).on("presence", { event: "sync" }, () => {});
    const sQ = await subscribe(chQ);
    await sleep(1500);
    const keys = Object.keys(chQ.presenceState());
    check("presença privada não vaza para o tópico PÚBLICO room:<id>", sQ.status === "SUBSCRIBED" && !keys.includes(`pf_b_${tag}`), `${sQ.status} ${short(keys)}`);
    await M.c.removeChannel(chQ);
  }
  // reconexão: derruba o socket do convidado e assina de novo
  await B.c.removeChannel(chB);
  B.c.realtime.disconnect();
  await sleep(500);
  const chB2 = B.c.channel(topic, { config: { private: true } });
  const sB2 = await subscribe(chB2);
  check("reconexão: o convidado volta ao canal privado", sB2.status === "SUBSCRIBED", short(sB2.log));
  await B.c.removeChannel(chB2);
  await A.c.removeChannel(chA);
}

// --------------------------------------------------------------------------
console.log("\n— Assinar ANTES de entrar (jogador otimista): recusado e liga sozinho depois");
{
  const J = await withSession("Jade/nova");
  const ch = J.c.channel(`room:${room.id}`, { config: { private: true } });
  const states = [];
  let subscribedAt = 0;
  ch.subscribe((s) => {
    states.push(s);
    if (s === "SUBSCRIBED" && !subscribedAt) subscribedAt = Date.now();
  });
  for (let i = 0; i < 20 && !states.includes("CHANNEL_ERROR"); i++) await sleep(250);
  const deniedFirst = states.includes("CHANNEL_ERROR") && !subscribedAt;
  const j = await J.c.rpc("rejoin_room", { p_code: room.code, p_player_id: `pf_j_${tag}`, p_nickname: "Jade", p_avatar: "j", p_color: "#555" });
  const t0 = Date.now();
  for (let i = 0; i < 100 && !subscribedAt; i++) await sleep(200);
  check(
    "antes de entrar: recusado; depois da entrada o cliente tenta de novo e assina",
    deniedFirst && !j.error && subscribedAt > 0,
    `${short(states)} · entrou ${!j.error} · assinou ${subscribedAt ? Math.max(0, subscribedAt - t0) + " ms após a entrada" : "não"}`,
  );
  await J.c.removeChannel(ch);
}

// --------------------------------------------------------------------------
console.log("\n— latency:<uid> (indicador de latência)");
{
  const ch = B.c.channel(`latency:${B.uid}`, { config: { private: true, broadcast: { ack: true, self: false } } });
  const s = await subscribe(ch);
  const r = s.status === "SUBSCRIBED" ? await ch.send({ type: "broadcast", event: "ping", payload: { t: 1 } }) : "não assinou";
  check("o dono assina o próprio canal de latência e o ping tem ack", s.status === "SUBSCRIBED" && r === "ok", `${short(s.log)} ${r}`);
  await B.c.removeChannel(ch);
  const chM = M.c.channel(`latency:${B.uid}`, { config: { private: true } });
  const sM = await subscribe(chM);
  check("outra sessão é recusada no canal de latência alheio", sM.status !== "SUBSCRIBED", short(sM.log));
  await M.c.removeChannel(chM);
}

// --------------------------------------------------------------------------
console.log("\n— Entradas simultâneas: todas passam a ler e a assinar");
{
  const N = 8;
  const gs = await Promise.all(Array.from({ length: N }, (_, i) => withSession(`G${i}`)));
  const pre = await Promise.all(gs.map((g) => g.c.from("players").select("id").eq("room_id", room.id)));
  const res = await Promise.all(
    gs.map((g, i) => g.c.rpc("rejoin_room", { p_code: room.code, p_player_id: `pf_g${i}_${tag}`, p_nickname: `G${i}`, p_avatar: "g", p_color: "#333" })),
  );
  const ok = res.filter((r) => !r.error && r.data?.id === room.id).length;
  const reads = await Promise.all(gs.map((g) => g.c.from("players").select("id").eq("room_id", room.id)));
  const subs = await Promise.all(gs.map((g) => subscribe(g.c.channel(`room:${room.id}`, { config: { private: true } }))));
  const total = Number((await db.query(`SELECT count(*) FROM public.players WHERE room_id = $1`, [room.id])).rows[0].count);
  check(
    `${N} entradas simultâneas: antes 0 linhas; depois todas leem players (${total}) e assinam o canal privado`,
    pre.every((r) => (r.data ?? []).length === 0) && ok === N && reads.every((r) => r.data?.length === total) && subs.every((s) => s.status === "SUBSCRIBED"),
    `${ok}/${N} · ${reads.map((r) => r.data?.length).join(",")} · ${subs.map((s) => s.status[0]).join("")}`,
  );
  for (const g of gs) g.c.removeAllChannels();
}

// --------------------------------------------------------------------------
console.log("\n— Fluxo do app antigo (vc8): entra pelo código, lê por room_id, canal público");
{
  await db.query(`INSERT INTO public.app_config (key, value) VALUES ('rooms_vc8_compat', 'ligado') ON CONFLICT (key) DO UPDATE SET value = 'ligado'`);
  const V = await withSession("vc8");
  const pre = await V.c.from("rooms").select("*").eq("code", room.code).maybeSingle();
  const j = await V.c.rpc("rejoin_room", { p_code: room.code, p_player_id: `pf_v_${tag}`, p_nickname: "V", p_avatar: "v", p_color: "#444" });
  const ps = await V.c.from("players").select("*").eq("room_id", room.id).is("kicked_at", null).order("joined_at");
  const rx = await V.c.from("round_extensions").select("*").eq("room_id", room.id);
  const vt = await V.c.from("votes").select("*").eq("room_id", room.id);
  // sorteio de palavra do vc8 (room.ts): room_words?select=id,word,category,created_at&room_id=eq.X
  const rw = await V.c.from("room_words").select("id,word,category,created_at").eq("room_id", room.id);
  const sync = await V.c.rpc("get_round_sync", { p_room_id: room.id });
  let got = 0;
  const ch = V.c.channel(`room:${room.id}`).on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${room.id}` }, () => got++);
  const s = await subscribe(ch);
  await sleep(2000);
  for (let i = 0; i < 6 && got === 0; i++) {
    await db.query(`UPDATE public.players SET score = score + 1 WHERE id = $1`, [`pf_a_${tag}`]);
    for (let t = 0; t < 10 && got === 0; t++) await sleep(250);
  }
  check(
    "vc8: lê por código → entra → lê players/round_extensions/votes/room_words/get_round_sync por id → recebe postgres_changes no canal público",
    pre.data?.id === room.id && !j.error && ps.data?.length > 3 && rx.data?.length === inRoom.round_extensions && vt.data?.length === inRoom.votes && rw.data?.length === inRoom.room_words && !!sync.data && s.status === "SUBSCRIBED" && got > 0,
    short([pre.error?.message, j.error?.message, ps.data?.length, rx.data?.length, vt.data?.length, rw.data?.length ?? rw.error?.code, !!sync.data, s.status, got]),
  );
  await V.c.removeChannel(ch);
  // Exposição que SOBRA até o vc9 (documentada): canal público com o mesmo nome segue aberto
  const chM = M.c.channel(`room:${room.id}`);
  const sM = await subscribe(chM);
  console.log(`ℹ residual documentado: canal PÚBLICO room:<id> assinável por quem tem o id (${sM.status}) — fecha com "Allow public access" desligado, depois do vc9`);
  await M.c.removeChannel(chM);
}

// --------------------------------------------------------------------------
for (const id of createdRooms) await db.query(`DELETE FROM public.rooms WHERE id = $1`, [id]);
for (const c of clients) {
  try {
    c.removeAllChannels();
    c.realtime.disconnect();
  } catch {
    /* já fechado */
  }
}
await db.end();
console.log(`\n${fail ? "❌" : "✅"} ${pass}/${pass + fail} verificações`);
process.exit(fail ? 1 : 0);
