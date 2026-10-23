// Pausa de partida (playtest 2026-10-21, sala 2246): partida humana parada
// não morre — e as salas-zumbi continuam sendo limpas.
//
// Caso real: 4 humanos foram almoçar depois da rodada 3; o tick seguiu
// sozinho (prorrogações −1/−1, expulsões, rodadas 4–6) e a R4 encerrou a sala
// 30 min depois do último voto ("Cris venceu"). Regra nova: escrita/votação
// vencendo sem nenhum humano presente → a sala PAUSA (rooms.paused_at); nada
// é punido, avançado nem encerrado; ela retoma quando todos voltam, no botão
// "Continuar" ou numa virada de fase, com prazo novo.
//
// Presença simulada direto em room_presence (o cliente manda touch_presence
// no toque e quando o app entra/sai da tela). Sala sem nenhuma presença
// (cliente antigo) segue a regra antiga — compatível antes do merge.
// Envs: DB_URL.
import pg from "pg";
import { readFileSync } from "node:fs";

const { DB_URL } = process.env;
const ssl = /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const db = new pg.Client({ connectionString: DB_URL, ssl });
await db.connect();
let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const row = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const short = (x) => JSON.stringify(x ?? null).slice(0, 200);
const tag = Math.random().toString(36).slice(2, 7);
const rooms = [];
let seq = 0;

// Partida em andamento na rodada `round`, fase `status` com prazo VENCIDO,
// `humans` humanos (+ `bots` bots) que jogaram as rodadas anteriores há
// `idleMin` minutos. `presence`: null = cliente antigo (sem presença);
// 'stale' = presença de há `idleMin` min; 'away' = saiu da tela; 'active' =
// tocou agora.
async function mkMatch({
  status = "writing",
  round = 4,
  humans = 4,
  bots = 0,
  idleMin = 45,
  presence = "stale",
} = {}) {
  seq++;
  const code = `PZ${tag}${seq}`;
  const host = `pz_h0_${tag}_${seq}`;
  const r = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, current_word_id, created_at,
                               phase_started_at, round_phase_ends_at, win_condition, win_target)
     VALUES ($1, $2, $3, $4, (SELECT id FROM public.words WHERE status = 'published' LIMIT 1),
             now() - interval '3 hours', now() - interval '90 seconds', now() - interval '10 seconds',
             'score', 15)
     RETURNING id`,
    [code, host, status, round],
  );
  rooms.push(r.id);
  const ids = [];
  for (let i = 0; i < humans; i++) {
    const id = `pz_h${i}_${tag}_${seq}`;
    ids.push(id);
    await db.query(
      `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, is_connected, joined_at, score)
       VALUES ($1, $2, $3, 'h', '#000', false, true, now() - interval '3 hours', $4)`,
      [id, r.id, `Humano${i}`, 5 + i],
    );
    if (presence) {
      const active = presence === "active" ? "now()" : `now() - make_interval(mins => ${idleMin})`;
      const away = presence === "away" ? "now()" : "NULL";
      await db.query(
        `INSERT INTO public.room_presence (player_id, room_id, active_at, away_at)
         VALUES ($1, $2, ${active}, ${away})`,
        [id, r.id],
      );
    }
  }
  const botIds = [];
  for (let i = 0; i < bots; i++) {
    const id = `bot_pz${i}${tag}${seq}`.slice(0, 20);
    botIds.push(id);
    await db.query(
      `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, is_connected, joined_at)
       VALUES ($1, $2, $3, 'b', '#111', true, true, now() - interval '3 hours')`,
      [id, r.id, `Bot${i}`],
    );
  }
  // rodadas anteriores jogadas por humanos (última ação humana = idleMin atrás)
  await db.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, 1, '__truth__', 'verdade r1', true, now() - interval '3 hours'),
            ($1, $3 - 1, $2, 'blefe antigo', false, now() - make_interval(mins => $4))`,
    [r.id, ids[0], round, idleMin],
  );
  return { id: r.id, code, ids, botIds };
}
const room = (id) =>
  row(
    `SELECT status, current_round, paused_at, finish_reason, round_phase_ends_at, phase_started_at
       FROM public.rooms WHERE id = $1`,
    [id],
  );
const scores = async (id) =>
  (await db.query(`SELECT id, score, kicked_at FROM public.players WHERE room_id = $1 ORDER BY id`, [id])).rows;
const exts = async (id) =>
  Number((await row(`SELECT count(*)::int AS n FROM public.round_extensions WHERE room_id = $1`, [id])).n);

// ── 1) A pausa: 4 humanos fora há 45 min, escrita vencida → PAUSA ──────────
const m1 = await mkMatch({ status: "writing", round: 4, humans: 4 });
const before1 = await scores(m1.id);
await db.query(`SELECT public.tick_stalled_rooms()`);
let s1 = await room(m1.id);
check("escrita vencida com a mesa inteira fora → PAUSA (não prorroga)", !!s1.paused_at && s1.status === "writing", short(s1));
check("ninguém perdeu ponto nem foi expulso", short(await scores(m1.id)) === short(before1));
check("nenhuma prorrogação aplicada", (await exts(m1.id)) === 0);

// tick seguinte: pausada não entra no laço
await db.query(`SELECT public.tick_stalled_rooms()`);
s1 = await room(m1.id);
check("tick seguinte não mexe na pausada", !!s1.paused_at && s1.status === "writing" && s1.current_round === 4);

// cliente (host aberto, mas parado) chamando a prorrogação: 'paused', sem −1
const ext1 = await row(`SELECT public.extend_writing_or_advance($1) AS r`, [m1.id]);
check("extend_writing_or_advance em sala pausada → 'paused'", ext1.r?.action === "paused", short(ext1.r));
check("…e continua sem punição", short(await scores(m1.id)) === short(before1) && (await exts(m1.id)) === 0);

// ── 2) >30 min parada: R4 / fase parada NÃO encerram a pausada ─────────────
await db.query(
  `UPDATE public.rooms SET paused_at = now() - interval '40 minutes',
          phase_started_at = now() - interval '2 hours' WHERE id = $1`,
  [m1.id],
);
const clean = await row(`SELECT public.cleanup_zombie_rooms() AS r`);
s1 = await room(m1.id);
check(
  "pausada há 40 min (rodada 4, sem ação humana há 45 min) NÃO é encerrada",
  s1.status === "writing" && !s1.finish_reason && !!s1.paused_at,
  short({ room: s1, cleanup: clean.r }),
);
check("placar e rodada preservados", short(await scores(m1.id)) === short(before1) && s1.current_round === 4);

// ── 3) Retomada: todos os humanos voltam → retoma sozinha, prazo novo ──────
for (const [i, id] of m1.ids.entries()) {
  const t = await row(`SELECT public.touch_presence($1, $2, 'active') AS r`, [m1.id, id]);
  if (i < m1.ids.length - 1)
    check(`humano ${i + 1}/4 de volta: ainda pausada (espera todos ou "Continuar")`, t.r?.ok && !t.r?.resumed && t.r?.paused, short(t.r));
  else check("o 4º humano voltou → retoma sozinha", t.r?.resumed === true, short(t.r));
}
s1 = await room(m1.id);
const endsIn = (new Date(s1.round_phase_ends_at).getTime() - Date.now()) / 1000;
check("retomou na MESMA fase e rodada", s1.status === "writing" && s1.current_round === 4 && !s1.paused_at, short(s1));
check("prazo novo de escrita (~60 s)", endsIn > 45 && endsIn <= 61, `${endsIn.toFixed(1)} s`);
check("placar preservado na retomada, sem vencedor", short(await scores(m1.id)) === short(before1) && s1.status !== "finished");
await db.query(`SELECT public.tick_stalled_rooms()`);
s1 = await room(m1.id);
check("tick (com limpeza) logo após a retomada não avança nem encerra", s1.status === "writing" && !s1.paused_at && !s1.finish_reason, short(s1));

// a partida continua: humano escreve, prazo vence com ele presente → regra normal
await db.query(
  `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth) VALUES ($1, 4, $2, 'blefe novo', false)`,
  [m1.id, m1.ids[0]],
);
const resumedEnds = s1.round_phase_ends_at;
await db.query(`UPDATE public.rooms SET round_phase_ends_at = now() - interval '10 seconds' WHERE id = $1`, [m1.id]);
const ext2 = await row(`SELECT public.extend_writing_or_advance($1) AS r`, [m1.id]);
check(
  "depois de retomar, quem segue fora com a mesa jogando cai na regra normal (prorrogação)",
  ext2.r?.action === "extended",
  short({ resumedEnds, r: ext2.r }),
);

// ── 4) Botão "Continuar" com só 1 de 3 humanos de volta ────────────────────
const m2 = await mkMatch({ status: "voting", round: 3, humans: 3, bots: 1 });
await db.query(`SELECT public.tick_stalled_rooms()`);
let s2 = await room(m2.id);
check("votação vencida com a mesa fora → PAUSA (não revela nem pontua)", !!s2.paused_at && s2.status === "voting");
check(
  "nenhuma pontuação da rodada (rounds) durante a pausa",
  Number((await row(`SELECT count(*)::int AS n FROM public.rounds WHERE room_id = $1`, [m2.id])).n) === 0,
);
const t2 = await row(`SELECT public.touch_presence($1, $2, 'active') AS r`, [m2.id, m2.ids[1]]);
check("1 de 3 de volta: ainda pausada", t2.r?.resumed !== true && !!(await room(m2.id)).paused_at, short(t2.r));
const bot2 = await row(`SELECT public.resume_room($1, $2) AS r`, [m2.id, m2.botIds[0]]);
check("bot não retoma partida", bot2.r?.ok === false, short(bot2.r));
const c2 = await row(`SELECT public.resume_room($1, $2) AS r`, [m2.id, m2.ids[1]]);
s2 = await room(m2.id);
const vEnds = (new Date(s2.round_phase_ends_at).getTime() - Date.now()) / 1000;
check("'Continuar' retoma a votação com prazo novo (~30 s)", c2.r?.resumed === true && !s2.paused_at && s2.status === "voting" && vEnds > 20 && vEnds <= 31, short({ r: c2.r, vEnds }));

// ── 5) 'away' conta como fora; bot presente não segura a mesa ──────────────
const m3 = await mkMatch({ status: "writing", round: 2, humans: 2, bots: 2, presence: "away" });
await db.query(
  `INSERT INTO public.room_presence (player_id, room_id, active_at) VALUES ($1, $2, now())`,
  [m3.botIds[0], m3.id],
);
await db.query(`SELECT public.tick_stalled_rooms()`);
check("todos saíram da tela ('away') + bot 'presente' → PAUSA mesmo assim", !!(await room(m3.id)).paused_at);

// ── 6) Humano presente: regra antiga (prorrogação do AFK) intacta ──────────
const m4 = await mkMatch({ status: "writing", round: 2, humans: 3, presence: "stale" });
await db.query(`UPDATE public.room_presence SET active_at = now() WHERE player_id = $1`, [m4.ids[0]]);
const e4 = await row(`SELECT public.extend_writing_or_advance($1) AS r`, [m4.id]);
check("com 1 humano presente, o prazo segue a regra normal (prorroga)", e4.r?.action === "extended" && !(await room(m4.id)).paused_at, short(e4.r));

// ── 7) Cliente antigo (sem presença): comportamento ANTIGO, idêntico ───────
const m5 = await mkMatch({ status: "writing", round: 2, humans: 2, presence: null });
const e5 = await row(`SELECT public.extend_writing_or_advance($1) AS r`, [m5.id]);
check("sala só de cliente antigo nunca pausa (prorroga como hoje)", e5.r?.action === "extended" && !(await room(m5.id)).paused_at, short(e5.r));

// ── 8) Zumbis continuam limpos ─────────────────────────────────────────────
// 8a) laço antigo (cliente antigo, sem ação humana há 45 min, rodada 4) → R4
const m6 = await mkMatch({ status: "voting", round: 4, humans: 1, bots: 2, presence: null });
await db.query(`UPDATE public.rooms SET phase_started_at = now(), round_phase_ends_at = now() + interval '20 seconds' WHERE id = $1`, [m6.id]);
await db.query(`SELECT public.cleanup_zombie_rooms()`);
let s6 = await room(m6.id);
check("laço sem humanos (cliente antigo) segue encerrado pela R4", s6.status === "finished" && s6.finish_reason === "cleanup_idle", short(s6));
// 8b) pausada há 13 h → TTL
const m7 = await mkMatch({ status: "writing", round: 3, humans: 2 });
await db.query(`UPDATE public.rooms SET paused_at = now() - interval '13 hours' WHERE id = $1`, [m7.id]);
await db.query(`SELECT public.cleanup_zombie_rooms()`);
let s7 = await room(m7.id);
check("pausada há 13 h → encerrada (cleanup_paused)", s7.status === "finished" && s7.finish_reason === "cleanup_paused" && !s7.paused_at, short(s7));
const xp7 = await row(
  `SELECT public.record_match_result($1) AS r`,
  [m7.code],
).catch((e) => ({ r: { err: e.message } }));
check("…e não paga XP (motivo de limpeza)", xp7.r?.ok !== true, short(xp7.r));
// 8c) pausada sem nenhum humano ativo na mesa (todos expulsos) → encerra
const m8 = await mkMatch({ status: "voting", round: 3, humans: 2, bots: 2 });
await db.query(`SELECT public.tick_stalled_rooms()`);
await db.query(`UPDATE public.players SET kicked_at = now() WHERE room_id = $1 AND is_bot = false`, [m8.id]);
await db.query(`SELECT public.cleanup_zombie_rooms()`);
let s8 = await room(m8.id);
check("pausada sem humano ativo (só bots) → encerrada (cleanup_empty)", s8.status === "finished" && s8.finish_reason === "cleanup_empty", short(s8));
// 8d) sala só de bots nunca pausa (não há quem esperar)
const m9 = await mkMatch({ status: "writing", round: 2, humans: 1, bots: 3 });
await db.query(`UPDATE public.players SET kicked_at = now() WHERE room_id = $1 AND is_bot = false`, [m9.id]);
await db.query(`SELECT public.tick_stalled_rooms()`);
check("mesa só com bots não pausa (segue a regra antiga até ser limpa)", !(await room(m9.id)).paused_at);

// ── 9) Virada de fase encerra a pausa; alerta ignora pausada ───────────────
// (votação → revelação: a escrita tem o gatilho que segura 'writing' com
// definição pendente, então a virada de teste é a da votação)
const m10 = await mkMatch({ status: "voting", round: 2, humans: 2 });
await db.query(`SELECT public.tick_stalled_rooms()`);
check("pausada (pré-condição)", !!(await room(m10.id)).paused_at);
await db.query(`UPDATE public.rooms SET status = 'reveal' WHERE id = $1`, [m10.id]);
const s10 = await room(m10.id);
check("virada de fase limpa paused_at (gatilho)", s10.status === "reveal" && !s10.paused_at, short(s10));

const m11 = await mkMatch({ status: "writing", round: 2, humans: 2 });
await db.query(`SELECT public.tick_stalled_rooms()`);
await db.query(`UPDATE public.rooms SET created_at = now() - interval '2 hours', phase_started_at = now() - interval '40 minutes' WHERE id = $1`, [m11.id]);
const health = await row(`SELECT public.ops_health_check() AS r`);
const stuckIds = (await db.query(
  `SELECT r.id FROM public.rooms r
    WHERE r.id = ANY($1) AND r.status IN ('choosing','writing','shuffling','voting','reveal','scoreboard')
      AND r.paused_at IS NULL AND r.created_at > now() - interval '1 day'
      AND COALESCE(r.phase_started_at, r.created_at) < now() - interval '15 minutes'`,
  [[m11.id]],
)).rows;
check("alerta de 'sala parada' não conta a pausada", stuckIds.length === 0, short(health.r?.metrics));

// ── 9b) Achados do Red Team (2026-10-21), cada um como regressão ───────────
// P0-1: depois de retomar uma pausa de 30+ min, a R4 NÃO encerra a partida
const r1 = await room(m1.id);
check(
  "P0-1: a R4 não encerra a partida depois da retomada (presença conta como atividade)",
  r1.status !== "finished" && !r1.finish_reason,
  short(r1),
);

// P0-2: o caminho do cliente (start_shuffling → gatilho) não pune nem avança
const g1 = await mkMatch({ status: "writing", round: 3, humans: 3 });
const gBefore = await scores(g1.id);
const ss1 = await row(`SELECT public.start_shuffling($1) AS r`, [g1.id]);
let gs = await room(g1.id);
check(
  "P0-2: aba aberta pedindo o embaralhamento com a mesa fora → pausa, sem −1 nem expulsão",
  gs.status === "writing" && !!gs.paused_at && short(await scores(g1.id)) === short(gBefore) && (await exts(g1.id)) === 0,
  short({ r: ss1.r, gs }),
);
await db.query(`SELECT public.start_shuffling($1)`, [g1.id]);
gs = await room(g1.id);
check(
  "P0-2: já pausada, novo pedido de embaralhamento segue sem punir",
  gs.status === "writing" && !!gs.paused_at && (await exts(g1.id)) === 0,
);

// P0-3: pausa encerrada por virada de fase renova o relógio — a regra de
// "fase parada" não mata a sala logo depois
const v1 = await mkMatch({ status: "voting", round: 3, humans: 2, bots: 1 });
await db.query(`UPDATE public.rooms SET current_coordinator = $2 WHERE id = $1`, [v1.id, v1.botIds[0]]);
const truth = await row(
  `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, letter)
   VALUES ($1, 3, '__truth__', 'verdade r3', true, 'A') RETURNING id`,
  [v1.id],
);
await db.query(
  `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, letter)
   VALUES ($1, 3, $2, 'blefe do bot', false, 'B')`,
  [v1.id, v1.botIds[0]],
);
await db.query(`SELECT public.tick_stalled_rooms()`);
check("P0-3 (pré): votação pausada", !!(await room(v1.id)).paused_at);
await db.query(
  `UPDATE public.rooms SET paused_at = now() - interval '2 hours', phase_started_at = now() - interval '2 hours' WHERE id = $1`,
  [v1.id],
);
for (const id of v1.ids)
  await db.query(
    `INSERT INTO public.votes (room_id, round, voter_id, definition_id) VALUES ($1, 3, $2, $3)`,
    [v1.id, id, truth.id],
  );
await db.query(`SELECT public.advance_voting_to_reveal($1)`, [v1.id]);
const vr = await room(v1.id);
const started = (Date.now() - new Date(vr.phase_started_at).getTime()) / 1000;
check(
  "P0-3: todos votaram durante a pausa → revelação, pausa limpa e relógio da fase renovado",
  vr.status === "reveal" && !vr.paused_at && started < 30,
  short({ vr, started }),
);
await db.query(`SELECT public.cleanup_zombie_rooms()`);
const vr2 = await room(v1.id);
check("P0-3: limpeza logo depois NÃO encerra a sala", vr2.status !== "finished", short(vr2));

// P1-4: ninguém humano devendo nada (só faltam bots) → segue, não pausa
const n1 = await mkMatch({ status: "writing", round: 3, humans: 2, bots: 1 });
for (const id of n1.ids)
  await db.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth) VALUES ($1, 3, $2, 'feita', false)`,
    [n1.id, id],
  );
const en1 = await row(`SELECT public.extend_writing_or_advance($1) AS r`, [n1.id]);
check(
  "P1-4: todos os humanos já escreveram (mesa fora) → a fase segue, sem pausa",
  en1.r?.action === "advanced" && !(await room(n1.id)).paused_at,
  short(en1.r),
);

// P1-4: retomar não zera os contadores (o ausente não perde −1 a cada Continuar)
const c1 = await mkMatch({ status: "voting", round: 3, humans: 2 });
await db.query(`UPDATE public.players SET voting_extensions = 1 WHERE id = $1`, [c1.ids[1]]);
await db.query(`SELECT public.tick_stalled_rooms()`);
await db.query(`SELECT public.resume_room($1, $2)`, [c1.id, c1.ids[0]]);
const ve = await row(`SELECT voting_extensions FROM public.players WHERE id = $1`, [c1.ids[1]]);
check("P1-4: retomar mantém o contador de prorrogação", ve.voting_extensions === 1, short(ve));

// P1-4/5: cada degrau exige toque NOVO (desde o início da fase/prorrogação)
const d1 = await mkMatch({ status: "writing", round: 3, humans: 2 });
await db.query(
  `UPDATE public.room_presence SET active_at = now() - interval '30 seconds' WHERE room_id = $1`,
  [d1.id],
);
const ed1 = await row(`SELECT public.extend_writing_or_advance($1) AS r`, [d1.id]);
check(
  "P1-5: tocou durante a fase e saiu → 1º degrau (−1) e só",
  ed1.r?.action === "extended",
  short(ed1.r),
);
await db.query(`UPDATE public.rooms SET round_phase_ends_at = now() - interval '10 seconds' WHERE id = $1`, [d1.id]);
const ed2 = await row(`SELECT public.extend_writing_or_advance($1) AS r`, [d1.id]);
check(
  "P1-5: sem toque novo depois da prorrogação → PAUSA (sem 2º −1 nem expulsão)",
  ed2.r?.action === "paused" && (await scores(d1.id)).every((p) => !p.kicked_at),
  short(ed2.r),
);

// P1-6: sala mista (humano de cliente antigo, sem presença) nunca congela
const x1 = await mkMatch({ status: "writing", round: 3, humans: 2 });
await db.query(`DELETE FROM public.room_presence WHERE player_id = $1`, [x1.ids[1]]);
const ex1 = await row(`SELECT public.extend_writing_or_advance($1) AS r`, [x1.id]);
check(
  "P1-6: humano sem presença (cliente antigo) conta como presente → regra antiga",
  ex1.r?.action === "extended" && !(await room(x1.id)).paused_at,
  short(ex1.r),
);

// P2: pausada em que todos tocaram em "Sair" → encerra (não espera 12 h)
const s1x = await mkMatch({ status: "writing", round: 3, humans: 2 });
await db.query(`SELECT public.tick_stalled_rooms()`);
await db.query(`UPDATE public.players SET is_connected = false WHERE room_id = $1 AND is_bot = false`, [s1x.id]);
await db.query(`SELECT public.cleanup_zombie_rooms()`);
const sx = await room(s1x.id);
check("P2: pausada e todos saíram (Sair) → encerrada (cleanup_empty)", sx.status === "finished" && sx.finish_reason === "cleanup_empty", short(sx));

// ── 10) Identidade da RPC: só jogador da mesa toca presença ────────────────
const U1 = "31111111-1111-4111-8111-111111111111";
await db.query(`UPDATE public.players SET user_id = $1 WHERE id = $2`, [U1, m2.ids[0]]);
await db.query("BEGIN");
await db.query(`SET LOCAL request.jwt.claims = '{"sub":"41111111-1111-4111-8111-111111111111","role":"authenticated"}'`);
const spoof = await row(`SELECT public.touch_presence($1, $2, 'active') AS r`, [m2.id, m2.ids[0]]);
const spoofResume = await row(`SELECT public.resume_room($1, $2) AS r`, [m2.id, m2.ids[0]]);
await db.query("ROLLBACK");
check("presença com o id de outra pessoa é recusada", spoof.r?.ok === false && spoof.r?.reason === "identity_mismatch", short(spoof.r));
check("'Continuar' com o id de outra pessoa é recusado", spoofResume.r?.ok === false, short(spoofResume.r));

// ── 11) Reversão aplica limpa (dentro de transação desfeita) ───────────────
await db.query("BEGIN");
try {
  await db.query(readFileSync("supabase/rollback/match_pause_resume.sql", "utf8"));
  const col = await row(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='rooms' AND column_name='paused_at'`,
  );
  const fn = await row(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'touch_presence'`);
  check("rollback da pausa aplica e remove as peças", col.n === 0 && fn.n === 0, short({ col, fn }));
} catch (e) {
  check("rollback da pausa aplica e remove as peças", false, e.message);
} finally {
  await db.query("ROLLBACK");
}

// limpeza
await db.query(`DELETE FROM public.room_presence WHERE room_id = ANY($1)`, [rooms]);
await db.query(`DELETE FROM public.round_extensions WHERE room_id = ANY($1)`, [rooms]);
await db.query(`DELETE FROM public.rounds WHERE room_id = ANY($1)`, [rooms]);
await db.query(`DELETE FROM public.votes WHERE room_id = ANY($1)`, [rooms]);
await db.query(`DELETE FROM public.definitions WHERE room_id = ANY($1)`, [rooms]);
await db.query(`DELETE FROM public.players WHERE room_id = ANY($1)`, [rooms]);
await db.query(`DELETE FROM public.rooms WHERE id = ANY($1)`, [rooms]);
await db.end();
console.log(`\n${total - fails}/${total} PAUSA ${fails ? "FALHOU" : "OK"}`);
process.exit(fails ? 1 : 0);
