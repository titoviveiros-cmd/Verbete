// Salas: leitura restrita a participantes (migration 20261112110000, 12/11/2026)
// pela API PÚBLICA real (PostgREST + Realtime do Supabase local da CI):
//   * enumeração: sem sessão e sessão de fora NÃO listam rooms nem leem por
//     filtro amplo (gt/in/or/like/not/combinado/embutido/contagem/GraphQL);
//   * leitura por código exato: só pela transitória do vc8 (interruptor
//     app_config.rooms_vc8_compat) e pela RPC get_room_state (só a sala);
//   * participante lê; expulso lê; de fora não recebe Realtime;
//   * entradas simultâneas pelo código;
//   * fluxo do app antigo (vc8) e do novo funcionam.
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
const setCompat = (v) =>
  db.query(
    `INSERT INTO public.app_config (key, value) VALUES ('rooms_vc8_compat', $1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [v],
  );

const newClient = () =>
  createClient(SUPA_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
async function withSession(label) {
  const c = newClient();
  const { data, error } = await c.auth.signInAnonymously();
  if (error || !data.session) throw new Error(`sessão anônima (${label}) falhou: ${error?.message}`);
  try {
    await c.realtime.setAuth(data.session.access_token);
  } catch {
    /* versões antigas: o cliente já repassa o token sozinho */
  }
  return { c, uid: data.user.id, token: data.session.access_token, label };
}

const tag = Math.random().toString(36).slice(2, 8);
const anon = { c: newClient(), label: "sem sessão" };
const A = await withSession("Ana/host");
const B = await withSession("Beto/convidado");
const K = await withSession("Kai/expulso");
const M = await withSession("Mallory/de fora");
const createdRooms = [];

// --------------------------------------------------------------------------
console.log("\n— Fluxo real: host cria, convidados entram pelo código (rejoin_room devolve a sala)");
await setCompat("desligado"); // o app NOVO não depende da transitória
const { data: room, error: cErr } = await A.c.rpc("create_room_with_host", {
  p_host_id: `rl_a_${tag}`, p_nickname: "Ana", p_avatar: "a", p_color: "#111",
});
if (cErr || !room?.id) {
  console.error("✖ não criou a sala de teste:", cErr?.message);
  process.exit(1);
}
createdRooms.push(room.id);
const code = room.code;
for (const [who, pid] of [[B, `rl_b_${tag}`], [K, `rl_k_${tag}`]]) {
  const { data, error } = await who.c.rpc("rejoin_room", {
    p_code: code, p_player_id: pid, p_nickname: who.label.split("/")[0], p_avatar: "b", p_color: "#222",
  });
  check(`${who.label} entra pelo código; rejoin_room devolve a sala`, !error && data?.id === room.id, short(error?.message ?? data?.code));
}
await db.query(`UPDATE public.players SET kicked_at = now() WHERE id = $1`, [`rl_k_${tag}`]);
const total = Number((await db.query(`SELECT count(*) FROM public.rooms`)).rows[0].count);

// --------------------------------------------------------------------------
console.log("\n— Enumeração pela REST (interruptor LIGADO: o pior caso da transitória)");
await setCompat("ligado");
{
  const raw = await fetch(`${SUPA_URL}/rest/v1/rooms?select=code`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, Prefer: "count=exact" },
  });
  const body = await raw.json().catch(() => null);
  const cr = raw.headers.get("content-range");
  check(
    `GET /rest/v1/rooms?select=code SEM sessão → 0 linhas (havia ${total}) ou 401/403`,
    (raw.status === 200 && Array.isArray(body) && body.length === 0) || [401, 403].includes(raw.status),
    `HTTP ${raw.status} · Content-Range ${cr} · ${short(body)}`,
  );
}
const listar = {
  "select=code": (c) => c.from("rooms").select("code"),
  "code=gt.0999": (c) => c.from("rooms").select("code").gt("code", "0999"),
  "code=gte&order&limit=1 (andar código a código)": (c) => c.from("rooms").select("code").gte("code", "1000").order("code").limit(1),
  "code=in.(…)": (c) => c.from("rooms").select("code").in("code", [code, "1000", "1001"]),
  "or=(code.eq…)": (c) => c.from("rooms").select("code").or(`code.eq.${code},code.eq.1000`),
  "code=like.*": (c) => c.from("rooms").select("code").like("code", "%"),
  "code=neq.0000": (c) => c.from("rooms").select("code").neq("code", "0000"),
  "not.code.eq": (c) => c.from("rooms").select("code").not("code", "eq", "0000"),
  "code=eq&status=eq": (c) => c.from("rooms").select("code").eq("code", code).eq("status", "lobby"),
  "code=eq&code=eq": (c) => c.from("rooms").select("code").eq("code", code).eq("code", code),
  "id=eq.<sala>": (c) => c.from("rooms").select("code").eq("id", room.id),
  "status=eq.lobby": (c) => c.from("rooms").select("code").eq("status", "lobby"),
};
for (const [who, label] of [[anon, "sem sessão"], [M, "sessão de fora"]]) {
  for (const [nome, q] of Object.entries(listar)) {
    const { data, error } = await q(who.c);
    check(`${label}: rooms?${nome} → 0 linhas`, (Array.isArray(data) && data.length === 0) || !!error, short(error?.message ?? data));
  }
  const { count, error } = await who.c.from("rooms").select("*", { count: "exact", head: true });
  check(`${label}: contagem exata de rooms → 0`, count === 0 || !!error, `${count} ${error?.message ?? ""}`);
  const emb = await who.c.from("players").select("id, rooms(code)").eq("room_id", room.id);
  check(
    `${label}: players?select=id,rooms(code) → rooms nulo (embutir não fura)`,
    !emb.error && (emb.data ?? []).every((p) => p.rooms === null),
    short(emb.error?.message ?? emb.data),
  );
}
{
  const g = await fetch(`${SUPA_URL}/graphql/v1`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${M.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ roomsCollection(first: 50) { edges { node { code } } } }" }),
  }).catch(() => null);
  if (!g || g.status === 404) console.log("ℹ GraphQL indisponível neste Supabase local — pulado");
  else {
    const j = await g.json().catch(() => null);
    const edges = j?.data?.roomsCollection?.edges;
    check("GraphQL (sessão de fora): roomsCollection → 0", !Array.isArray(edges) || edges.length === 0, short(j));
  }
}

// --------------------------------------------------------------------------
console.log("\n— Código exato (app antigo vc8: rooms?select=*&code=eq.X, com o PostgREST REAL)");
{
  let r = await M.c.from("rooms").select("*").eq("code", code).maybeSingle();
  check("LIGADO: sessão de fora lê a sala pelo código exato (forma do vc8)", !r.error && r.data?.id === room.id, short(r.error?.message ?? r.data?.code));
  r = await M.c.from("rooms").select("*", { count: "exact" }).eq("code", code);
  check("LIGADO: mesma leitura com contagem exata", !r.error && r.data?.length === 1, short(r.error?.message ?? r.count));
  r = await anon.c.from("rooms").select("*").eq("code", code).maybeSingle();
  check("LIGADO: SEM sessão não lê nem pelo código exato", !r.data, short(r.error?.message ?? r.data));
  await setCompat("desligado");
  r = await M.c.from("rooms").select("*").eq("code", code).maybeSingle();
  check("DESLIGADO: sessão de fora não lê pelo código exato", !r.data, short(r.error?.message ?? r.data));
  await db.query(`DELETE FROM public.app_config WHERE key = 'rooms_vc8_compat'`);
  r = await M.c.from("rooms").select("*").eq("code", code).maybeSingle();
  check("chave AUSENTE = desligado", !r.data, short(r.data));
  await setCompat("ligado");
}

// --------------------------------------------------------------------------
console.log("\n— Participantes");
for (const [who, label] of [[A, "host"], [B, "convidado"], [K, "expulso"]]) {
  const r = await who.c.from("rooms").select("status,current_round,host_id").eq("id", room.id).maybeSingle();
  check(`${label} lê a sala por id (polling)`, !r.error && r.data?.status === "lobby", short(r.error?.message ?? r.data));
  const l = await who.c.from("rooms").select("code");
  check(`${label} listando: SÓ a própria sala`, !l.error && l.data.length === 1 && l.data[0].code === code, short(l.data));
}

// --------------------------------------------------------------------------
console.log("\n— get_room_state");
{
  let r = await B.c.rpc("get_room_state", { p_code: code });
  check("participante: estado completo", r.data?.room?.id === room.id && r.data.players.length === 2, short(r.data?.players?.length));
  r = await M.c.rpc("get_room_state", { p_code: code });
  check(
    "de fora: só a sala (sem jogadores, definições, votos, palavra)",
    r.data?.room?.id === room.id && r.data.players.length === 0 && r.data.definitions.length === 0 && r.data.votes.length === 0 && r.data.word === null,
    short(r.data),
  );
  r = await anon.c.rpc("get_room_state", { p_code: code });
  check("LIGADO: sem sessão recebe só a sala (convite aberto antes da sessão)", r.data?.room?.id === room.id && r.data.players.length === 0, short(r.error?.message ?? r.data));
  await setCompat("desligado");
  r = await anon.c.rpc("get_room_state", { p_code: code });
  check("DESLIGADO: sem sessão → null", r.data === null, short(r.error?.message ?? r.data));
  r = await M.c.rpc("get_room_state", { p_code: "0000" });
  check("código inexistente → null", r.data === null, short(r.data));
  await setCompat("ligado");
}

// --------------------------------------------------------------------------
console.log("\n— record_match_result: mesma resposta para inexistente e sala alheia");
{
  const a = await M.c.rpc("record_match_result", { p_room_code: code });
  const b = await M.c.rpc("record_match_result", { p_room_code: "0000" });
  check(
    "inexistente = sala alheia = player_not_linked",
    a.data?.reason === "player_not_linked" && b.data?.reason === "player_not_linked",
    short([a.data ?? a.error?.message, b.data ?? b.error?.message]),
  );
}

// --------------------------------------------------------------------------
console.log("\n— Realtime (postgres_changes em rooms, filtro id=eq.<sala>)");
{
  const got = { B: 0, M: 0, anon: 0 };
  const subs = [];
  const status = {};
  for (const [key, who] of [["B", B], ["M", M], ["anon", anon]]) {
    const ch = who.c
      .channel(`rl-${key}-${tag}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${room.id}` }, () => {
        got[key]++;
      })
      .subscribe((s) => {
        status[key] = s;
      });
    subs.push([who, ch]);
  }
  for (let i = 0; i < 40 && Object.keys(status).length < 3; i++) await sleep(250);
  await sleep(2000); // o Realtime liga a assinatura no banco logo depois do SUBSCRIBED
  for (let i = 0; i < 6 && got.B === 0; i++) {
    await db.query(`UPDATE public.rooms SET win_target = win_target + 1 WHERE id = $1`, [room.id]);
    for (let t = 0; t < 10 && got.B === 0; t++) await sleep(250);
  }
  await sleep(1500);
  check("participante RECEBE a mudança da sala", got.B > 0, `${short(status)} eventos=${short(got)}`);
  check("sessão de fora NÃO recebe", got.M === 0, short(got));
  check("sem sessão NÃO recebe", got.anon === 0, short(got));
  for (const [who, ch] of subs) await who.c.removeChannel(ch);
}

// --------------------------------------------------------------------------
console.log("\n— Entradas simultâneas pelo código (app novo, interruptor DESLIGADO)");
await setCompat("desligado");
{
  const N = 8;
  const gs = await Promise.all(Array.from({ length: N }, (_, i) => withSession(`G${i}`)));
  const res = await Promise.all(
    gs.map((g, i) =>
      g.c.rpc("rejoin_room", { p_code: code, p_player_id: `rl_g${i}_${tag}`, p_nickname: `G${i}`, p_avatar: "g", p_color: "#333" }),
    ),
  );
  const ok = res.filter((r) => !r.error && r.data?.id === room.id).length;
  const reads = await Promise.all(gs.map((g) => g.c.from("rooms").select("id").eq("id", room.id).maybeSingle()));
  check(`${N} entradas simultâneas: todas entram e passam a ler a sala`, ok === N && reads.every((r) => r.data?.id === room.id), `${ok}/${N} · ${reads.filter((r) => r.data).length}/${N}`);
  const st = await gs[0].c.rpc("get_room_state", { p_code: code });
  check("depois de entrar, get_room_state vem completo", (st.data?.players?.length ?? 0) >= 2 + N, short(st.data?.players?.length));
}

// --------------------------------------------------------------------------
console.log("\n— Fluxo do app antigo (vc8) com o interruptor LIGADO");
await setCompat("ligado");
{
  const V = await withSession("vc8");
  const pre = await V.c.from("rooms").select("*").eq("code", code).maybeSingle();
  const j = await V.c.rpc("rejoin_room", { p_code: code, p_player_id: `rl_v_${tag}`, p_nickname: "V", p_avatar: "v", p_color: "#444" });
  const poll = await V.c.from("rooms").select("status,current_round").eq("id", room.id).maybeSingle();
  check("vc8: lê por código → entra → lê por id", pre.data?.id === room.id && j.data?.id === room.id && poll.data?.status === "lobby", short([pre.error?.message, j.error?.message, poll.error?.message]));
}

// --------------------------------------------------------------------------
for (const id of createdRooms) await db.query(`DELETE FROM public.rooms WHERE id = $1`, [id]);
await setCompat("ligado");
await db.end();
console.log(`\n${fail ? "❌" : "✅"} ${pass}/${pass + fail} verificações`);
process.exit(fail ? 1 : 0);
