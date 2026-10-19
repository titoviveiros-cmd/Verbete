// R4 anti-laço — sala em fase de jogo sem ATIVIDADE HUMANA real há 30+ min
// é encerrada pelo cleanup que roda no tick (mesmo com o tick avançando as
// fases e com is_connected=true "velho" — o padrão das 37 salas de julho/
// agosto e da 7397, que rodaram ~1.079 rodadas até esgotar as palavras).
//
// Atividade humana = entrada (players.joined_at), definição não-verdade,
// voto, mensagem no chat e reação de emoji — sempre de jogador humano —,
// mais o início da partida (verdade da rodada 1: start_game apaga as
// definições antigas) e a criação da sala. NÃO contam: bots, a verdade
// automática ('__truth__'), o tick, mudança de fase, prazos, is_connected.
// A rodada 1 inteira é carência (sala recém-iniciada).
//
// Concorrência: o cleanup trava a sala com FOR UPDATE SKIP LOCKED; todo
// INSERT de ação humana (FK para rooms → FOR KEY SHARE) ou cast_vote
// (FOR UPDATE) em andamento faz a sala ser pulada naquele minuto, e a
// inatividade é reconferida depois de travar.
// Envs: DB_URL.
import pg from "pg";

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
const short = (x) => JSON.stringify(x ?? null).slice(0, 180);
const tag = Math.random().toString(36).slice(2, 7);
const rooms = [];
let seq = 0;
const startedAt = (await row(`SELECT now() AS t`)).t;

// Sala "em laço": fase de jogo com prazo vencido e fase RECÉM-renovada (o
// tick acabou de avançar), um humano conectado (flag velha) que não age há
// `idleMin` minutos, e bots ativos agora.
async function mkLoopRoom({
  status = "voting",
  round = 50,
  idleMin = 120,
  createdMin = 600,
  truthR1Min = 600,
} = {}) {
  seq++;
  const code = `R4${tag}${seq}`;
  const r = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, created_at, phase_started_at, round_phase_ends_at,
                               win_condition, win_target)
     VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5), now() - interval '20 seconds',
             now() - interval '5 seconds', 'score', 15)
     RETURNING id`,
    [code, `r4_h_${tag}_${seq}`, status, round, createdMin],
  );
  rooms.push(r.id);
  const human = `r4_h_${tag}_${seq}`;
  const bot = `r4_b_${tag}_${seq}`;
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, is_connected, joined_at)
     VALUES ($1, $3, 'Humano', 'h', '#000', false, true, now() - make_interval(mins => $4)),
            ($2, $3, 'Bot', 'b', '#111', true, true, now() - make_interval(mins => $4))`,
    [human, bot, r.id, idleMin],
  );
  // verdade da rodada 1 (início da partida) e verdade da rodada atual (agora)
  const truthR1 = await row(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, 1, '__truth__', 'verdade r1', true, now() - make_interval(mins => $2)) RETURNING id`,
    [r.id, truthR1Min],
  );
  const truthNow =
    round === 1
      ? truthR1
      : await row(
          `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
           VALUES ($1, $2, '__truth__', 'verdade atual', true, now()) RETURNING id`,
          [r.id, round],
        );
  // humano agiu pela última vez há idleMin (definição e voto antigos)
  await db.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, 2, $2, 'definicao antiga do humano', false, now() - make_interval(mins => $3))`,
    [r.id, human, idleMin],
  );
  // bots agindo AGORA (definição e voto na rodada atual)
  const botDef = await row(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, $2, $3, 'definicao do bot agora', false, now()) RETURNING id`,
    [r.id, round, bot],
  );
  // (o bot vota na verdade: votar na própria definição é barrado pelo gatilho)
  await db.query(
    `INSERT INTO public.votes (room_id, round, voter_id, definition_id, created_at) VALUES ($1, $2, $3, $4, now())`,
    [r.id, round, bot, truthNow.id],
  );
  return { id: r.id, human, bot, round, botDefId: botDef.id };
}
const statusOf = async (id) => (await row(`SELECT status FROM public.rooms WHERE id = $1`, [id])).status;
const cleanup = async () => (await row(`SELECT public.cleanup_zombie_rooms() AS r`)).r;

// ---------------------------------------------------------------------------
console.log("— A. LAÇO: humano parado há 2 h, is_connected=true velho, bots e tick ativos");
{
  const loop = await mkLoopRoom();
  const t = (await row(`SELECT public.tick_stalled_rooms() AS t`)).t; // tick roda o cleanup
  check("sala em laço é encerrada (tick + cleanup)", (await statusOf(loop.id)) === "finished", short(t?.cleanup));
  const loop2 = await mkLoopRoom({ status: "choosing", round: 1079 });
  await cleanup();
  check("também em choosing na rodada 1.079 (as 37 de julho/agosto)", (await statusOf(loop2.id)) === "finished");
  const loop3 = await mkLoopRoom({ status: "scoreboard", round: 7 });
  await cleanup();
  check("também no placar", (await statusOf(loop3.id)) === "finished");
}

console.log("\n— B. HUMANO ATIVO: qualquer ação recente segura a sala");
{
  const d = await mkLoopRoom({ status: "writing" });
  await db.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, $2, $3, 'definicao recente do humano', false, now() - interval '5 minutes')`,
    [d.id, d.round, d.human],
  );
  const v = await mkLoopRoom({ status: "reveal" });
  await db.query(
    `INSERT INTO public.votes (room_id, round, voter_id, definition_id, created_at)
     VALUES ($1, $2, $3, $4, now() - interval '5 minutes')`,
    [v.id, v.round, v.human, v.botDefId],
  );
  const m = await mkLoopRoom({ status: "voting" });
  await db.query(
    `INSERT INTO public.room_messages (room_id, player_id, text, created_at) VALUES ($1, $2, 'oi', now() - interval '5 minutes')`,
    [m.id, m.human],
  );
  const e = await mkLoopRoom({ status: "choosing" });
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, is_connected, joined_at)
     VALUES ($1, $2, 'Novo', 'n', '#222', false, true, now() - interval '5 minutes')`,
    [`r4_n_${tag}_${seq}`, e.id],
  );
  const re = await mkLoopRoom({ status: "voting" });
  await db.query(
    `INSERT INTO public.reactions (room_id, player_id, emoji, created_at) VALUES ($1, $2, '😂', now() - interval '5 minutes')`,
    [re.id, re.human],
  );
  await cleanup();
  check("definição humana há 5 min → não encerra", (await statusOf(d.id)) === "writing");
  check("voto humano há 5 min → não encerra", (await statusOf(v.id)) === "reveal");
  check("mensagem humana há 5 min → não encerra", (await statusOf(m.id)) === "voting");
  check("entrada de humano há 5 min → não encerra", (await statusOf(e.id)) === "choosing");
  check("reação de humano há 5 min → não encerra", (await statusOf(re.id)) === "voting");
}

console.log("\n— C. BOTS: ação só de bots não mantém a sala viva");
{
  const b = await mkLoopRoom({ status: "voting" });
  await db.query(
    `INSERT INTO public.room_messages (room_id, player_id, text, created_at) VALUES ($1, $2, 'sou bot', now())`,
    [b.id, b.bot],
  );
  await db.query(
    `INSERT INTO public.reactions (room_id, player_id, emoji, created_at) VALUES ($1, $2, '🤖', now())`,
    [b.id, b.bot],
  );
  await cleanup();
  check("definição, voto, mensagem e reação de bot agora → encerra mesmo assim", (await statusOf(b.id)) === "finished");
}

console.log("\n— D. SERVIDOR: tick, mudança de fase e verdade automática não contam");
{
  const s = await mkLoopRoom({ status: "writing" });
  // o "servidor" mexe agora: fase nova, prazo novo, verdade nova
  await db.query(
    `UPDATE public.rooms SET phase_started_at = now(), round_phase_ends_at = now() + interval '60 seconds' WHERE id = $1`,
    [s.id],
  );
  await db.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, $2, '__truth__', 'outra verdade', true, now())
     ON CONFLICT (room_id, round, player_id) DO UPDATE SET created_at = now()`,
    [s.id, s.round + 1],
  );
  await cleanup();
  check("fase/prazo renovados e verdade recém-criada → encerra", (await statusOf(s.id)) === "finished");
}

console.log("\n— E. LIMITE: 29m59s não encerra; 30m01s encerra (mesma transação: now() fixo)");
{
  for (const [label, interval, expected] of [
    ["29m59s", "29 minutes 59 seconds", "voting"],
    ["30m01s", "30 minutes 1 second", "finished"],
  ]) {
    await db.query("BEGIN");
    try {
      const l = await mkLoopRoom({ status: "voting" });
      await db.query(
        `INSERT INTO public.votes (room_id, round, voter_id, definition_id, created_at)
         VALUES ($1, $2, $3, $4, now() - $5::interval)`,
        [l.id, l.round, l.human, l.botDefId, interval],
      );
      await cleanup();
      const st = await statusOf(l.id);
      await db.query("COMMIT");
      check(`última ação humana há ${label} → ${expected === "finished" ? "encerra" : "não encerra"}`, st === expected, st);
    } catch (e) {
      await db.query("ROLLBACK");
      check(`limite ${label}`, false, String(e).slice(0, 160));
    }
  }
}

console.log("\n— Proteções: sala recém-iniciada e partida que começou há pouco");
{
  const r1 = await mkLoopRoom({ status: "writing", round: 1 });
  const novo = await mkLoopRoom({ status: "voting", round: 2, truthR1Min: 10 });
  const criada = await mkLoopRoom({ status: "voting", round: 3, createdMin: 20, truthR1Min: 15, idleMin: 20 });
  await cleanup();
  check("rodada 1 (carência de sala recém-iniciada) → não encerra", (await statusOf(r1.id)) === "writing");
  check("partida iniciada há 10 min (verdade da rodada 1), lobby parado há 2 h → não encerra", (await statusOf(novo.id)) === "voting");
  check("sala criada há 20 min → não encerra", (await statusOf(criada.id)) === "voting");
}

console.log("\n— F. CONCORRÊNCIA: ação humana em andamento no limite não é atropelada");
{
  const c = await mkLoopRoom({ status: "voting" });
  const other = new pg.Client({ connectionString: DB_URL, ssl });
  await other.connect();
  try {
    // outra conexão: humano votando AGORA (transação aberta — o INSERT com FK
    // para rooms segura FOR KEY SHARE na linha da sala, como o cast_vote real
    // que ainda trava a sala com FOR UPDATE)
    await other.query("BEGIN");
    await other.query(
      `INSERT INTO public.votes (room_id, round, voter_id, definition_id, created_at) VALUES ($1, $2, $3, $4, now())`,
      [c.id, c.round, c.human, c.botDefId],
    );
    const t0 = Date.now();
    const res = await cleanup(); // não pode esperar nem encerrar: pula a sala travada
    const waited = Date.now() - t0;
    check(
      "cleanup não bloqueia nem encerra sala com ação humana em andamento",
      (await statusOf(c.id)) === "voting" && waited < 3000,
      `${waited} ms · ${short(res)}`,
    );
    await other.query("COMMIT");
    await cleanup(); // no minuto seguinte, com o voto já gravado
    check("depois do commit, o voto recente mantém a sala viva", (await statusOf(c.id)) === "voting");
  } finally {
    await other.query("ROLLBACK").catch(() => {});
    await other.end();
  }

  // ordem inversa: o cleanup decide primeiro (transação aberta) e o voto chega
  // depois → o voto espera; o cast_vote real, que relê a sala com FOR UPDATE,
  // veria 'finished' e recusaria (nada fica pela metade).
  const d = await mkLoopRoom({ status: "voting" });
  const late = new pg.Client({ connectionString: DB_URL, ssl });
  await late.connect();
  try {
    await db.query("BEGIN");
    await db.query(`SELECT public.cleanup_zombie_rooms()`);
    const pending = late.query(
      `SELECT status FROM public.rooms WHERE id = $1 FOR UPDATE`, // o que o cast_vote faz primeiro
      [d.id],
    );
    await new Promise((r) => setTimeout(r, 300));
    await db.query("COMMIT");
    const seen = (await pending).rows[0]?.status;
    check("voto que chega depois da decisão encontra a sala já 'finished' (cast_vote recusaria)", seen === "finished", seen);
  } finally {
    await late.end();
  }
}

console.log("\n— G. REGRESSÃO: regras da v2 seguem valendo");
{
  seq++;
  const stale = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, created_at, phase_started_at, round_phase_ends_at)
     VALUES ($1, 'x', 'choosing', 1, now() - interval '50 minutes', now() - interval '40 minutes', now() + interval '50 seconds')
     RETURNING id`,
    [`R4${tag}${seq}`],
  );
  rooms.push(stale.id);
  seq++;
  const lobbyAtivo = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, created_at) VALUES ($1, 'x', 'lobby', 0, now() - interval '45 minutes') RETURNING id`,
    [`R4${tag}${seq}`],
  );
  rooms.push(lobbyAtivo.id);
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, joined_at) VALUES ($1, $2, 'L', 'l', '#333', false, now() - interval '5 minutes')`,
    [`r4_l_${tag}_${seq}`, lobbyAtivo.id],
  );
  const res = await cleanup();
  check("v2: fase parada há 40 min (prazo rearmado) segue sendo encerrada", (await statusOf(stale.id)) === "finished", short(res));
  check("v2: lobby com entrada há 5 min segue aberto", (await statusOf(lobbyAtivo.id)) === "lobby");
  check("retorno informa as salas encerradas pela R4", res && "finished_idle" in res, short(res));
}

// ---------------------------------------------------------------------------
await db.query(`DELETE FROM public.rooms WHERE id = ANY($1)`, [rooms]);
// eventos gerados pelo tick durante o teste (não poluir as próximas suítes)
await db.query(
  `DELETE FROM public.ops_events WHERE at >= $1 AND kind IN ('tick_error', 'stalled_advance')`,
  [startedAt],
);
await db.end();
console.log(fails ? `\n${fails}/${total} FALHAS` : `\nR4 ANTI-LAÇO OK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
