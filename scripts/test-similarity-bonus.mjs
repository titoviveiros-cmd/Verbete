// Regressão da auditoria 2026-07-29: apply_similarity_bonus deve ser
// idempotente e presa à sala/rodada. Sala sintética direto no banco.
// Envs: DB_URL.
import pg from "pg";
const db = new pg.Client({
  connectionString: process.env.DB_URL,
  ssl: /supabase\.co/.test(process.env.DB_URL ?? "")
    ? { rejectUnauthorized: false }
    : false,
});
await db.connect();
let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const rpc3 = async (roomId, round, ids) =>
  (
    await db.query(
      `SELECT public.apply_similarity_bonus($1::uuid, $2::int, $3::uuid[]) AS r`,
      [roomId, round, ids],
    )
  ).rows[0].r;
const score = async (pid) =>
  (await db.query(`SELECT score FROM public.players WHERE id = $1`, [pid]))
    .rows[0].score;

// Cenário: sala com 1 jogador, 1 blefe e 1 verdade na rodada 1
const { rows: rr } = await db.query(
  `INSERT INTO public.rooms (code, host_id, current_round) VALUES ('ZB' || floor(random()*90+10)::text, 'simbonus_p', 1) RETURNING id`,
);
const roomId = rr[0].id;
await db.query(
  `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, score) VALUES ('simbonus_p', $1, 'P', '🦊', '#f00', true, 0)`,
  [roomId],
);
const { rows: dd } = await db.query(
  `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
   VALUES ($1, 1, 'simbonus_p', 'blefe do jogador', false),
          ($1, 1, '__truth__', 'significado verdadeiro', true)
   RETURNING id, is_truth`,
  [roomId],
);
const bluffId = dd.find((d) => !d.is_truth).id;
const truthId = dd.find((d) => d.is_truth).id;

// 1) primeira chamada premia
const r1 = await rpc3(roomId, 1, [bluffId]);
check("1ª chamada premia (+3)", r1.bumped === 1 && (await score("simbonus_p")) === 3, JSON.stringify(r1));

// 2) REPLAY não soma de novo (o achado da auditoria)
const r2 = await rpc3(roomId, 1, [bluffId]);
check("replay não soma (bumped=0, score=3)", r2.bumped === 0 && (await score("simbonus_p")) === 3, JSON.stringify(r2));

// 3) rodada errada não premia
await db.query(`UPDATE public.definitions SET near_truth = false WHERE id = $1`, [bluffId]);
const r3 = await rpc3(roomId, 2, [bluffId]);
check("rodada errada não premia", r3.bumped === 0 && (await score("simbonus_p")) === 3, JSON.stringify(r3));

// 4) sala errada não premia
const r4 = await rpc3("00000000-0000-0000-0000-000000000000", 1, [bluffId]);
check("sala errada não premia", r4.bumped === 0 && (await score("simbonus_p")) === 3, JSON.stringify(r4));

// 5) a verdade nunca premia
const r5 = await rpc3(roomId, 1, [truthId]);
check("verdade não premia", r5.bumped === 0, JSON.stringify(r5));

// 6) assinatura antiga está desativada
const { rows: old } = await db.query(
  `SELECT public.apply_similarity_bonus($1::uuid[]) AS r`,
  [[bluffId]],
);
check(
  "assinatura antiga deprecada (ok=false)",
  old[0].r.ok === false && (await score("simbonus_p")) === 3,
  JSON.stringify(old[0].r),
);

// limpeza
await db.query(`DELETE FROM public.definitions WHERE room_id = $1`, [roomId]);
await db.query(`DELETE FROM public.players WHERE room_id = $1`, [roomId]);
await db.query(`DELETE FROM public.rooms WHERE id = $1`, [roomId]);
await db.end();
console.log(fails === 0 ? "\nBONUS IDEMPOTENTE OK" : `\n${fails} FALHAS`);
process.exit(fails === 0 ? 0 : 1);
