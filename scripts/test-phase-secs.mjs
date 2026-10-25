// Smoke do public.phase_secs: sala sintética com N jogadores, confere o fator.
import pg from "pg";
const DB_URL = process.env.DB_URL;
const db = new pg.Client({
  connectionString: DB_URL,
  ssl: /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false,
});
await db.connect();
let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

const { rows: roomRows } = await db.query(
  `INSERT INTO public.rooms (code, host_id) VALUES ('ZZ' || floor(random()*90+10)::text, 'smoke_host') RETURNING id`,
);
const roomId = roomRows[0].id;

async function setPlayers(n) {
  await db.query(`DELETE FROM public.players WHERE room_id = $1`, [roomId]);
  for (let i = 0; i < n; i++) {
    await db.query(
      `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot) VALUES ($1, $2, $3, '🤖', '#888', true)`,
      [`smoke_p${i}`, roomId, `P${i}`],
    );
  }
}
async function secs(base) {
  const { rows } = await db.query(
    `SELECT public.phase_secs($1, $2) AS s`,
    [roomId, base],
  );
  return rows[0].s;
}

// phase_secs segue genérica (votação, espera da revelação, escolha da
// palavra); a ESCRITA saiu dela em 2026-10-25 (ver o bloco no fim).
await setPlayers(4);
check("4 jogadores: votação segue 30s", (await secs(30)) === 30, `${await secs(30)}s`);
check("4 jogadores: base 60 (escolha) segue 60s", (await secs(60)) === 60, `${await secs(60)}s`);

await setPlayers(6);
check("6 jogadores: votação segue 30s", (await secs(30)) === 30, `${await secs(30)}s`);

await setPlayers(7);
check("7 jogadores: votação vira 35s", (await secs(30)) === 35, `${await secs(30)}s`);
check("7 jogadores: base 60 (escolha) vira 70s", (await secs(60)) === 70, `${await secs(60)}s`);

await setPlayers(10);
check("10 jogadores: votação vira 50s", (await secs(30)) === 50, `${await secs(30)}s`);

await setPlayers(12);
check("12 jogadores: votação vira 60s (2x)", (await secs(30)) === 60, `${await secs(30)}s`);
check("12 jogadores: base 60 (escolha) vira 120s (2x)", (await secs(60)) === 120, `${await secs(60)}s`);
check("12 jogadores: espera da revelação 20s vira 40s", (await secs(20)) === 40, `${await secs(20)}s`);

// Expulsos não contam
await db.query(
  `UPDATE public.players SET kicked_at = now() WHERE room_id = $1 AND id IN ('smoke_p0','smoke_p1','smoke_p2','smoke_p3','smoke_p4','smoke_p5')`,
  [roomId],
);
check("12 - 6 expulsos = 6 ativos: volta a 30s", (await secs(30)) === 30, `${await secs(30)}s`);

// ---------------------------------------------------------------------------
// ESCRITA com tempo fixo (2026-10-25): cada jogador escreve UMA definição —
// o prazo é a base + 10 s com 4 ou com 12 na sala, nas 3 portas de entrada
// (escolha da palavra, escolha automática, volta da pausa); a prorrogação
// também não escala. Falha se alguém voltar a ligar a escrita ao nº de
// jogadores. A votação continua escalando.
const { rows: [w] } = await db.query(
  `SELECT id FROM public.words WHERE status = 'published' LIMIT 1`,
);
const left = async () =>
  Number(
    (
      await db.query(
        `SELECT extract(epoch FROM round_phase_ends_at - now())::numeric AS s FROM public.rooms WHERE id = $1`,
        [roomId],
      )
    ).rows[0].s,
  );
const about = (s, target) => Math.abs(s - target) <= 2;
const toChoosing = (deadline = "now() + interval '60 seconds'") =>
  db.query(
    `UPDATE public.rooms SET status = 'choosing', current_round = 1, current_word_id = NULL,
            used_word_ids = '{}', paused_at = NULL, round_phase_ends_at = ${deadline}
      WHERE id = $1`,
    [roomId],
  );
check(
  "writing_phase_secs(60) = 70 (base + 10 s)",
  (await db.query(`SELECT public.writing_phase_secs(60) AS s`)).rows[0].s === 70,
);
const writing = {};
for (const n of [4, 12]) {
  await setPlayers(n);
  await toChoosing();
  await db.query(`SELECT public.choose_word($1, $2, 60)`, [roomId, w.id]);
  writing[n] = await left();
}
check(
  "escolha da palavra: escrita de 70 s com 4 E com 12 jogadores",
  about(writing[4], 70) && about(writing[12], 70),
  `4=${writing[4].toFixed(1)}s 12=${writing[12].toFixed(1)}s`,
);
await toChoosing("now() - interval '1 second'");
const auto = (
  await db.query(`SELECT public.advance_choosing_to_writing($1) AS r`, [roomId])
).rows[0].r;
const autoLeft = await left();
check(
  "escolha automática (12 jogadores): escrita de 70 s",
  auto?.action === "auto_picked" && about(autoLeft, 70),
  `${JSON.stringify(auto)} ${autoLeft.toFixed(1)}s`,
);
// pausa num UPDATE separado: mudar o status junto zera a pausa (gatilho
// rooms_clear_paused_at)
const pauseIn = async (status, round) => {
  await db.query(
    `UPDATE public.rooms SET status = $2, current_round = $3 WHERE id = $1`,
    [roomId, status, round],
  );
  await db.query(`UPDATE public.rooms SET paused_at = now() WHERE id = $1`, [roomId]);
};
await pauseIn("writing", 1);
await db.query(`SELECT public.resume_paused_room($1)`, [roomId]);
const resumedWriting = await left();
await pauseIn("voting", 2);
await db.query(`SELECT public.resume_paused_room($1)`, [roomId]);
const resumedVoting = await left();
check(
  "volta da pausa (12 jogadores): escrita 70 s; votação segue escalando (60 s)",
  about(resumedWriting, 70) && about(resumedVoting, 60),
  `escrita=${resumedWriting.toFixed(1)}s votação=${resumedVoting.toFixed(1)}s`,
);
// prorrogação: 11 bots + 1 humano que não escreveu (12 na sala)
await setPlayers(11);
await db.query(
  `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, joined_at)
   VALUES ('smoke_h', $1, 'Humano', '🙂', '#888', false, now() - interval '10 minutes')`,
  [roomId],
);
await db.query(
  `UPDATE public.rooms SET status = 'writing', current_round = 3, current_coordinator = 'smoke_p0',
          paused_at = NULL, phase_started_at = now() - interval '2 minutes',
          round_phase_ends_at = now() - interval '5 seconds'
    WHERE id = $1`,
  [roomId],
);
const ext = (
  await db.query(`SELECT public.extend_writing_or_advance($1) AS r`, [roomId])
).rows[0].r;
check(
  "prorrogação da escrita (12 jogadores): 20 s fixos (antes 40 s)",
  ext?.action === "extended" && ext?.seconds === 20 && about(await left(), 20),
  JSON.stringify(ext),
);
await db.query(`DELETE FROM public.round_extensions WHERE room_id = $1`, [roomId]);

await db.query(`DELETE FROM public.players WHERE room_id = $1`, [roomId]);
await db.query(`DELETE FROM public.rooms WHERE id = $1`, [roomId]);
await db.end();
console.log(fails === 0 ? "\nPHASE_SECS OK" : `\n${fails} FALHAS`);
process.exit(fails === 0 ? 0 : 1);
