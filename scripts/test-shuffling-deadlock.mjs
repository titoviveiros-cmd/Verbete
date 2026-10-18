// M1 · Lote E — regressão do SM-01: o estado 'shuffling' nunca pode prender
// a sala com um humano que ainda não escreveu. Três caminhos:
//   1) writing → start_shuffling PREMATURO com humano pendente;
//   2) jogador expulso que VOLTA durante o shuffling (o caminho real);
//   3) sala já presa (estado legado) — destravada pela RPC e pelo cron.
// Envs: SUPA_URL, ANON, DB_URL.
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
const row = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const short = (x) => JSON.stringify(x ?? null).slice(0, 140);
const status = async (rid) => (await row(`SELECT status FROM public.rooms WHERE id = $1`, [rid])).status;
const session = async () => {
  const c = createClient(SUPA_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await c.auth.signInAnonymously();
  if (error) throw error;
  return c;
};

const tag = Math.random().toString(36).slice(2, 8);
const [host, p2, p3] = [await session(), await session(), await session()];
const H = `shf_h_${tag}`;
const P2 = `shf_2_${tag}`;
const P3 = `shf_3_${tag}`;
const { id: wordId } = await row(`SELECT id FROM public.words WHERE meaning IS NOT NULL LIMIT 1`);
// Os cenários reaproveitam os mesmos ids (e sessões): limpa sala E jogadores.
const dropRoom = async (rid) => {
  await db.query(`DELETE FROM public.rooms WHERE id = $1`, [rid]);
  await db.query(`DELETE FROM public.players WHERE id = ANY($1)`, [[H, P2, P3]]);
};

// Sala em 'writing', coordenador = host, prazo longe (o cron não interfere).
async function roomInWriting() {
  const { data: room, error } = await host.rpc("create_room_with_host", {
    p_host_id: H, p_nickname: "Host", p_avatar: "🦊", p_color: "#f00",
  });
  if (error) throw error;
  for (const [c, id] of [[p2, P2], [p3, P3]]) {
    const { error: e } = await c.rpc("rejoin_room", {
      p_code: room.code, p_player_id: id, p_nickname: id.slice(0, 8), p_avatar: "🐸", p_color: "#0f0",
    });
    if (e) throw e;
  }
  await host.rpc("start_game", { p_room_id: room.id });
  await db.query(`UPDATE public.rooms SET current_coordinator = $2 WHERE id = $1`, [room.id, H]);
  await host.rpc("choose_word", { p_room_id: room.id, p_word_id: wordId, p_duration_sec: 60 });
  // Fase de escrita "em andamento há 1 min" (fora da tolerância de 3 s do
  // início de fase) com prazo longe — o teste roda em segundos.
  await db.query(
    `UPDATE public.rooms
        SET round_phase_ends_at = now() + interval '10 minutes',
            phase_started_at = now() - interval '1 minute'
      WHERE id = $1`,
    [room.id],
  );
  await db.query(
    `UPDATE public.players SET joined_at = now() - interval '2 minutes' WHERE room_id = $1`,
    [room.id],
  );
  return room;
}

// ---------------------------------------------------------------------------
console.log("— 1) start_shuffling prematuro com humano pendente");
let room = await roomInWriting();
let rid = room.id;
check("sala em writing", (await status(rid)) === "writing");
await p2.rpc("submit_definition", { p_room_id: rid, p_player_id: P2, p_text: "planta rasteira do brejo" });
let r = await p2.rpc("start_shuffling", { p_room_id: rid });
check(
  "start_shuffling com P3 pendente responde ok=false (pending_players)",
  r.data?.ok === false && r.data?.reason === "pending_players",
  short(r.data),
);
check("a sala NÃO sai de writing", (await status(rid)) === "writing", await status(rid));
r = await p3.rpc("submit_definition", { p_room_id: rid, p_player_id: P3, p_text: "chapeu de palha largo" });
check("o pendente ainda consegue escrever", r.data?.ok === true, short(r.data));
r = await p2.rpc("start_shuffling", { p_room_id: rid });
check("com todos escritos, embaralha", r.data?.ok === true && (await status(rid)) === "shuffling", short(r.data));
await p2.rpc("advance_writing_to_voting", { p_room_id: rid });
check("e a votação abre", (await status(rid)) === "voting", await status(rid));
await dropRoom(rid);

// ---------------------------------------------------------------------------
console.log("\n— 2) expulso que volta DURANTE o shuffling (caminho real do deadlock)");
room = await roomInWriting();
rid = room.id;
r = await host.rpc("kick_player", { p_room_id: rid, p_actor_id: H, p_target_player_id: P3 });
check("host expulsa P3 durante a escrita", r.data?.ok === true, short(r.data));
await p2.rpc("submit_definition", { p_room_id: rid, p_player_id: P2, p_text: "peixe pequeno de rio" });
r = await p2.rpc("start_shuffling", { p_room_id: rid });
check("sem pendentes (P3 expulso): embaralha", r.data?.ok === true, short(r.data));
r = await p3.rpc("rejoin_room", {
  p_code: room.code, p_player_id: P3, p_nickname: "Volta", p_avatar: "🐸", p_color: "#0f0",
});
check("P3 volta durante o shuffling", !r.error, r.error?.message);
await p2.rpc("advance_writing_to_voting", { p_room_id: rid });
check("a rodada segue para a votação (P3 conta como entrada tardia)", (await status(rid)) === "voting", await status(rid));
await dropRoom(rid);

// ---------------------------------------------------------------------------
console.log("\n— 3) sala JÁ presa em shuffling com pendente (estado legado)");
room = await roomInWriting();
rid = room.id;
await p2.rpc("submit_definition", { p_room_id: rid, p_player_id: P2, p_text: "vento quente do sertao" });
// Reproduz o estado que travava salas em produção: shuffling + P3 sem definição.
await db.query(`ALTER TABLE public.rooms DISABLE TRIGGER guard_writing_phase_advance_trigger`);
await db.query(`UPDATE public.rooms SET status = 'shuffling' WHERE id = $1`, [rid]);
await db.query(`ALTER TABLE public.rooms ENABLE TRIGGER guard_writing_phase_advance_trigger`);
check("estado legado reproduzido (shuffling com pendente)", (await status(rid)) === "shuffling");
r = await p3.rpc("submit_definition", { p_room_id: rid, p_player_id: P3, p_text: "x" });
check("em shuffling o pendente não consegue escrever (o deadlock)", r.data?.reason === "wrong_phase", short(r.data));
await p2.rpc("advance_writing_to_voting", { p_room_id: rid });
check("advance_writing_to_voting devolve a sala para writing", (await status(rid)) === "writing", await status(rid));
r = await p3.rpc("submit_definition", { p_room_id: rid, p_player_id: P3, p_text: "festa junina no interior" });
check("agora o pendente escreve", r.data?.ok === true, short(r.data));
await p2.rpc("start_shuffling", { p_room_id: rid });
await p2.rpc("advance_writing_to_voting", { p_room_id: rid });
check("e a rodada chega à votação", (await status(rid)) === "voting", await status(rid));
await dropRoom(rid);

console.log("\n— 3b) mesmo estado, destravado só pelo cron (tick_stalled_rooms)");
room = await roomInWriting();
rid = room.id;
await p2.rpc("submit_definition", { p_room_id: rid, p_player_id: P2, p_text: "cesto de cipo trancado" });
await db.query(`ALTER TABLE public.rooms DISABLE TRIGGER guard_writing_phase_advance_trigger`);
await db.query(`UPDATE public.rooms SET status = 'shuffling' WHERE id = $1`, [rid]);
await db.query(`ALTER TABLE public.rooms ENABLE TRIGGER guard_writing_phase_advance_trigger`);
const tick = await row(`SELECT public.tick_stalled_rooms() AS t`);
check("o tick devolve a sala presa para writing", (await status(rid)) === "writing", short(tick.t));
const prazo = await row(
  `SELECT round_phase_ends_at > now() + interval '5 minutes' AS mantido FROM public.rooms WHERE id = $1`,
  [rid],
);
check("os prazos da fase NÃO mudam (regra de tempo intacta)", prazo.mantido === true);
await dropRoom(rid);

await db.query(`DELETE FROM public.players WHERE id LIKE $1`, [`shf_%_${tag}`]);
await db.end();
console.log(fails ? `\n${fails}/${total} FALHAS` : `\nSHUFFLING SEM DEADLOCK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
