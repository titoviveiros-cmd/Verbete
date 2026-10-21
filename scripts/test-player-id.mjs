// Identidade do jogador: um player_id pertence a UMA sala (playtest
// 2026-10-21). Antes, o jogador recorrente que entrava numa sala nova levava
// 'duplicate key value violates unique constraint "players_pkey"' na tela
// (rejoin_room fazia INSERT puro), e criar sala MOVIA a linha antiga de sala
// em silêncio. Agora: id em outra sala ou de outra pessoa → 'player_id_taken'
// (o cliente gera um id novo e tenta 1×); mesma sala → reentrada normal.
// Sessões simuladas por request.jwt.claims (auth.uid() lê esse GUC).
// Envs: DB_URL.
import pg from "pg";
import { readFileSync } from "node:fs";

const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const db = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await db.connect();
let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const short = (x) => JSON.stringify(x ?? null).slice(0, 200);
const tag = Math.random().toString(36).slice(2, 7);
const U1 = "51111111-1111-4111-8111-111111111111";
const U2 = "52222222-2222-4222-8222-222222222222";
const rooms = [];

// RPC como usuário (claims) numa transação própria; devolve linhas ou erro.
async function as(uid, sql, params) {
  await db.query("BEGIN");
  try {
    if (uid)
      await db.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: uid, role: "authenticated" })],
      );
    const r = await db.query(sql, params);
    await db.query("COMMIT");
    return { ok: true, rows: r.rows };
  } catch (e) {
    await db.query("ROLLBACK");
    return { ok: false, error: String(e.message) };
  }
}
const noDbLeak = (r) => !/duplicate key|players_pkey|violates|constraint/i.test(r.error ?? "");

const P1 = `p_pid1${tag}`;
const P2 = `p_pid2${tag}`;

// 1) U1 cria a sala A com P1 (jogador novo)
const a = await as(U1, `SELECT * FROM public.create_room_with_host($1, 'Ana', 'a', '#000')`, [P1]);
check("jogador novo cria sala", a.ok, short(a));
const roomA = a.rows?.[0];
if (roomA) rooms.push(roomA.id);
await db.query(`UPDATE public.players SET score = 7 WHERE id = $1`, [P1]);

// sala B (outra partida)
const b = await as(U2, `SELECT * FROM public.create_room_with_host($1, 'Beto', 'b', '#111')`, [P2]);
const roomB = b.rows?.[0];
if (roomB) rooms.push(roomB.id);

// 2) mesmo aparelho (P1) entra na sala B → player_id_taken, sem erro do banco
const j1 = await as(U1, `SELECT public.rejoin_room($1, $2, 'Ana', 'a', '#000')`, [roomB.code, P1]);
check("mesmo id em sala nova → 'player_id_taken'", !j1.ok && /player_id_taken/.test(j1.error), short(j1));
check("…sem mensagem de chave/constraint do banco", noDbLeak(j1), j1.error);
const stay = await one(`SELECT room_id, score FROM public.players WHERE id = $1`, [P1]);
check("o jogador NÃO foi movido da sala antiga (linha e placar intactos)", stay.room_id === roomA.id && stay.score === 7, short(stay));

// 3) 2ª tentativa com id novo (o que o cliente faz) → entra
const P3 = `p_pid3${tag}`;
const j2 = await as(U1, `SELECT public.rejoin_room($1, $2, 'Ana', 'a', '#000')`, [roomB.code, P3]);
check("2ª tentativa com id novo entra normalmente", j2.ok, short(j2));
const inB = await one(`SELECT room_id, user_id FROM public.players WHERE id = $1`, [P3]);
check("…na sala B e reivindicado pelo usuário", inB?.room_id === roomB.id && inB?.user_id === U1, short(inB));

// 4) reentrada na MESMA sala: normal, placar preservado
const j3 = await as(U1, `SELECT public.rejoin_room($1, $2, 'Ana', 'a', '#000')`, [roomA.code, P1]);
const back = await one(`SELECT room_id, score FROM public.players WHERE id = $1`, [P1]);
check("rejoin na mesma sala funciona e preserva o placar", j3.ok && back.score === 7, short({ j3, back }));

// 5) sequestro: outro usuário tenta usar o id de U1
const h1 = await as(U2, `SELECT public.rejoin_room($1, $2, 'X', 'x', '#222')`, [roomB.code, P1]);
check("outro usuário com o id de U1 (outra sala) → 'player_id_taken'", !h1.ok && /player_id_taken/.test(h1.error), short(h1));
const h2 = await as(U2, `SELECT public.rejoin_room($1, $2, 'X', 'x', '#222')`, [roomA.code, P1]);
check("outro usuário com o id de U1 (mesma sala) → 'player_id_taken'", !h2.ok && /player_id_taken/.test(h2.error), short(h2));
const h3 = await as(U2, `SELECT * FROM public.create_room_with_host($1, 'X', 'x', '#222')`, [P1]);
check("outro usuário criando sala com o id de U1 → 'player_id_taken'", !h3.ok && /player_id_taken/.test(h3.error), short(h3));
const stay2 = await one(`SELECT room_id, user_id, nickname FROM public.players WHERE id = $1`, [P1]);
check("a vítima segue na sala dela, com o nome dela", stay2.room_id === roomA.id && stay2.user_id === U1 && stay2.nickname === "Ana", short(stay2));

// 6) criar sala com id já usado (do próprio usuário, partida anterior) → id novo
const c2 = await as(U1, `SELECT * FROM public.create_room_with_host($1, 'Ana', 'a', '#000')`, [P1]);
check("criar sala com id de partida anterior → 'player_id_taken' (não move)", !c2.ok && /player_id_taken/.test(c2.error) && noDbLeak(c2), short(c2));
const orphan = await one(`SELECT count(*)::int AS n FROM public.rooms WHERE host_id = $1 AND id <> $2`, [P1, roomA.id]);
check("…e nenhuma sala órfã foi criada", orphan.n === 0, short(orphan));

// 7) partida rápida (sala pública) com id existente → 'player_id_taken'
const q1 = await as(U1, `SELECT * FROM public.join_public_room($1, 'Ana', 'a', '#000')`, [P1]);
check("partida rápida com id existente → 'player_id_taken'", !q1.ok && /player_id_taken/.test(q1.error), short(q1));

// 8) convidado anônimo (sessão anônima = authenticated com is_anonymous)
const U3 = "53333333-3333-4333-8333-333333333333";
const P4 = `p_pid4${tag}`;
const g1 = await as(U3, `SELECT public.rejoin_room($1, $2, 'Gui', 'g', '#333')`, [roomA.code, P4]);
check("convidado anônimo novo entra", g1.ok, short(g1));
const g2 = await as(U3, `SELECT public.rejoin_room($1, $2, 'Gui', 'g', '#333')`, [roomB.code, P4]);
check("convidado anônimo em outra sala com o mesmo id → 'player_id_taken'", !g2.ok && /player_id_taken/.test(g2.error) && noDbLeak(g2), short(g2));

// 9) reversão aplica limpa (transação desfeita)
await db.query("BEGIN");
try {
  await db.query(readFileSync("supabase/rollback/player_id_one_room.sql", "utf8"));
  check("rollback da identidade aplica limpo", true);
} catch (e) {
  check("rollback da identidade aplica limpo", false, e.message);
} finally {
  await db.query("ROLLBACK");
}

await db.query(`DELETE FROM public.players WHERE room_id = ANY($1)`, [rooms]);
await db.query(`DELETE FROM public.rooms WHERE id = ANY($1)`, [rooms]);
await db.end();
console.log(`\n${total - fails}/${total} IDENTIDADE ${fails ? "FALHOU" : "OK"}`);
process.exit(fails ? 1 : 0);
