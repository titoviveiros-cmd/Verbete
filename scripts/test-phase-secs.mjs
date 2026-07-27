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

await setPlayers(4);
check("4 jogadores: votação segue 30s", (await secs(30)) === 30, `${await secs(30)}s`);
check("4 jogadores: escrita segue 60s", (await secs(60)) === 60, `${await secs(60)}s`);

await setPlayers(6);
check("6 jogadores: votação segue 30s", (await secs(30)) === 30, `${await secs(30)}s`);

await setPlayers(7);
check("7 jogadores: votação vira 35s", (await secs(30)) === 35, `${await secs(30)}s`);
check("7 jogadores: escrita vira 70s", (await secs(60)) === 70, `${await secs(60)}s`);

await setPlayers(10);
check("10 jogadores: votação vira 50s", (await secs(30)) === 50, `${await secs(30)}s`);

await setPlayers(12);
check("12 jogadores: votação vira 60s (2x)", (await secs(30)) === 60, `${await secs(30)}s`);
check("12 jogadores: escrita vira 120s (2x)", (await secs(60)) === 120, `${await secs(60)}s`);
check("12 jogadores: prorrogação 20s vira 40s", (await secs(20)) === 40, `${await secs(20)}s`);

// Expulsos não contam
await db.query(
  `UPDATE public.players SET kicked_at = now() WHERE room_id = $1 AND id IN ('smoke_p0','smoke_p1','smoke_p2','smoke_p3','smoke_p4','smoke_p5')`,
  [roomId],
);
check("12 - 6 expulsos = 6 ativos: volta a 30s", (await secs(30)) === 30, `${await secs(30)}s`);

await db.query(`DELETE FROM public.players WHERE room_id = $1`, [roomId]);
await db.query(`DELETE FROM public.rooms WHERE id = $1`, [roomId]);
await db.end();
console.log(fails === 0 ? "\nPHASE_SECS OK" : `\n${fails} FALHAS`);
process.exit(fails === 0 ? 0 : 1);
