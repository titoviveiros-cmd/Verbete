// 2.1.4 — "🤏 Quase acertou! Faltou precisão." (era "Quase lá!" até 05/11/2026) (nota 50–79 do juiz 🧠, sem bônus).
// A edge grava a marca com service_role (apply_similarity_near_miss); o autor
// lê só a própria, da rodada atual, a partir da revelação (get_my_near_miss).
// Sessões simuladas via SET LOCAL request.jwt.claims (como test-identity).
// Tudo numa transação desfeita no fim. Envs: DB_URL.
import { readFileSync } from "node:fs";
import pg from "pg";

const { DB_URL } = process.env;
const ssl = /supabase\.co/.test(DB_URL ?? "")
  ? { rejectUnauthorized: false }
  : false;
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

const U_ME = "31111111-1111-4111-8111-111111111111";
const U_BIA = "32222222-2222-4222-8222-222222222222";
const asUser = (uid) =>
  db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    uid ? JSON.stringify({ sub: uid, role: "authenticated" }) : "",
  ]);

await db.query("BEGIN");
try {
  const tag = Math.random().toString(36).slice(2, 7);
  await db.query(
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $3, '', now(), now()),
            ($2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $4, '', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [U_ME, U_BIA, `nm_me_${tag}@test.local`, `nm_bia_${tag}@test.local`],
  );
  const room = async (code) =>
    (
      await row(
        `INSERT INTO public.rooms (code, host_id, status, current_round) VALUES ($1, $2, 'voting', 2) RETURNING id`,
        [code, `nm_me_${tag}`],
      )
    ).id;
  const R1 = await room(`NM${tag}`);
  const R2 = await room(`NN${tag}`);
  const player = (id, rid, uid) =>
    db.query(
      `INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id) VALUES ($1, $2, $1, 'x', '#000', $3)`,
      [id, rid, uid],
    );
  await player(`nm_me_${tag}`, R1, U_ME);
  await player(`nm_bia_${tag}`, R1, U_BIA);
  await player(`nm_x_${tag}`, R2, null);
  const def = async (rid, round, pid, truth = false) =>
    (
      await row(
        `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [rid, round, pid, `texto ${pid} ${round}`, truth],
      )
    ).id;
  const dMe = await def(R1, 2, `nm_me_${tag}`);
  const dBia = await def(R1, 2, `nm_bia_${tag}`);
  const dTruth = await def(R1, 2, "__truth__", true);
  const dOld = await def(R1, 1, `nm_me_${tag}`);
  const dOther = await def(R2, 2, `nm_x_${tag}`);
  // a Bia levou o +3 (80+): mesmo que a lista venha errada, não vira "quase"
  await db.query(`UPDATE public.definitions SET near_truth = true WHERE id = $1`, [dBia]);

  const apply = async (rid, round, ids) =>
    (
      await row(
        "SELECT public.apply_similarity_near_miss($1, $2, $3::uuid[]) n",
        [rid, round, ids],
      )
    ).n;
  const n1 = await apply(R1, 2, [dMe, dBia, dTruth, dOld, dOther]);
  check("grava só blefe da sala/rodada; nunca verdade, +3, outra rodada/sala", n1 === 1, `gravou ${n1}`);
  check("replay idempotente (reenvio do juiz)", (await apply(R1, 2, [dMe])) === 0);

  const get = async (pid, uid, rid = R1) => {
    await asUser(uid);
    return (await row("SELECT public.get_my_near_miss($1, $2) r", [rid, pid])).r;
  };
  check("votação: nada vaza, nem ao autor", (await get(`nm_me_${tag}`, U_ME)) === false);
  for (const st of ["reveal", "scoreboard", "finished"]) {
    await asUser(null);
    await db.query(`UPDATE public.rooms SET status = $1 WHERE id = $2`, [st, R1]);
    check(`${st}: o autor recebe a própria marca`, (await get(`nm_me_${tag}`, U_ME)) === true);
  }
  check("isolamento: Bia perguntando pela marca de outro jogador recebe false", (await get(`nm_me_${tag}`, U_BIA)) === false);
  check("Bia (sem marca) recebe false", (await get(`nm_bia_${tag}`, U_BIA)) === false);
  check("reconexão: nova consulta com a mesma sessão segue true", (await get(`nm_me_${tag}`, U_ME)) === true);
  await asUser(null);
  await db.query(`UPDATE public.rooms SET status = 'writing', current_round = 3 WHERE id = $1`, [R1]);
  check("rodada seguinte: a marca anterior não aparece", (await get(`nm_me_${tag}`, U_ME)) === false);

  const priv = await row(`SELECT
    has_function_privilege('anon', 'public.apply_similarity_near_miss(uuid,int,uuid[])', 'EXECUTE') aa,
    has_function_privilege('authenticated', 'public.apply_similarity_near_miss(uuid,int,uuid[])', 'EXECUTE') au,
    has_function_privilege('service_role', 'public.apply_similarity_near_miss(uuid,int,uuid[])', 'EXECUTE') asr,
    has_table_privilege('anon', 'public.definition_near_miss', 'SELECT') ts,
    has_table_privilege('authenticated', 'public.definition_near_miss', 'SELECT') tsa`);
  check(
    "gravação só service_role; tabela fechada para clients",
    !priv.aa && !priv.au && priv.asr && !priv.ts && !priv.tsa,
    JSON.stringify(priv),
  );
  await asUser(null);
  await db.query(`DELETE FROM public.rooms WHERE id = $1`, [R1]);
  const left = await row(`SELECT count(*)::int n FROM public.definition_near_miss WHERE room_id = $1`, [R1]);
  check("sala apagada (retenção) leva as marcas junto", left.n === 0, `restaram ${left.n}`);
  // Rollback (dentro da transação desfeita): tabela e funções saem.
  await db.query(readFileSync("supabase/rollback/judge_near_miss.sql", "utf8"));
  const gone = await row(
    `SELECT (SELECT count(*)::int FROM pg_proc WHERE proname IN ('apply_similarity_near_miss', 'get_my_near_miss')) f,
            to_regclass('public.definition_near_miss') IS NULL t`,
  );
  check("rollback remove tabela e funções", gone.f === 0 && gone.t === true, JSON.stringify(gone));
} catch (e) {
  check("suíte rodou até o fim", false, e.message);
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}
console.log(`\n${total - fails}/${total} verificações OK`);
process.exit(fails ? 1 : 0);
