// Conquistas (20261122120000_conquistas_regras) no POSTGRES REAL do CI (19/11/2026):
//  A) CORRIDA: duas (ou mais) conexões independentes concedendo a MESMA conquista ao mesmo
//     usuário ao mesmo tempo → uma única linha, nenhuma chamada com erro, só uma relata.
//     A simultaneidade é provada: a conexão B fica BLOQUEADA enquanto A segura a transação.
//  B) CONTROLE do arranjo: o mesmo arranjo derruba uma concessão SEM `ON CONFLICT`
//     (unique_violation) — prova que a janela de corrida é real e que o teste a enxerga.
//  C) ROLLBACK (supabase/rollback/conquistas_regras.sql) ensaiado DENTRO de uma transação
//     desfeita no fim: preserva XP/pontuação/estatísticas/conquistas/tentativas, continua em
//     horas o Diário jogado depois da migration, devolve o corpo de produção (md5 e41b8c87).
// Uso (CI): DB_URL=postgres://...@127.0.0.1:54322/postgres node scripts/test-conquistas-corrida.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RB = readFileSync(join(ROOT, "supabase/rollback/conquistas_regras.sql"), "utf8");

const DB_URL = process.env.DB_URL ?? process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("✖ DB_URL ausente: este teste só passa num Postgres REAL (corrida entre conexões).");
  process.exit(1);
}
const host = new URL(DB_URL).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  console.error(`✖ recusado: DB_URL aponta para "${host}". Este teste altera dados e só roda em banco LOCAL.`);
  process.exit(1);
}

const { default: pg } = await import("pg");
const abertas = [];
const conn = async () => {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("SET statement_timeout = '15s'"); // nada de CI pendurado se algo travar
  abertas.push(c);
  return c;
};
const main = await conn();
const q = async (s, p = []) => (await main.query(s, p)).rows;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const falhas = [];
async function t(nome, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✔ ${nome}`);
  } catch (e) {
    fail++;
    falhas.push(nome);
    console.log(`  ✖ ${nome}\n      ${e?.message ?? e}`);
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${msg ?? "diferente"}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
};

const criados = [];
const novoUsuario = async () => {
  const id = randomUUID();
  criados.push(id);
  await q(`INSERT INTO auth.users (id, is_anonymous) VALUES ($1, false)`, [id]);
  return id;
};
const linhas = async (u, code) =>
  (await q(`SELECT count(*)::int n FROM public.user_achievements WHERE user_id = $1 AND achievement_code = $2`, [u, code]))[0].n;
const md5Pontuacao = async () =>
  (await q(`SELECT md5(prosrc) m FROM pg_proc WHERE proname = 'submit_daily_attempt_scored'`))[0].m;

/** B dispara com A segurando a transação; devolve se B ESPEROU e o resultado (ou erro) de B. */
async function corrida(sqlA, paramsA, sqlB, paramsB) {
  const A = await conn();
  const B = await conn();
  await A.query("BEGIN");
  const ra = (await A.query(sqlA, paramsA)).rows[0];
  let terminou = false;
  const pb = B.query(sqlB, paramsB).then(
    (r) => ((terminou = true), { ok: r.rows[0] }),
    (e) => ((terminou = true), { erro: e }),
  );
  await espera(500);
  const esperou = !terminou;
  await A.query("COMMIT");
  const rb = await pb;
  return { ra, rb, esperou };
}

console.log(`Conquistas: corrida e rollback no Postgres real (${host})`);
const md5Inicial = await md5Pontuacao();
const zz = ["zz_teste_corrida_sem_on_conflict", "zz_teste_corrida_com_on_conflict"];

try {
  await t("0. banco do CI com a migration de conquistas aplicada (corpo da pontuação a6242f5b)", async () => {
    eq(md5Inicial.slice(0, 8), "a6242f5b", "md5");
    eq((await q(`SELECT to_regclass('public.conquistas_streak_horas_bkp') IS NOT NULL r`))[0].r, true, "backup");
  });

  // ---------------------------------------------------------------- A) corrida real
  await t("A1. 2 conexões, mesma conquista (escolha × escolha): B ESPERA A; 1 linha; nenhum erro; só A relata", async () => {
    const u = await novoUsuario();
    const sql = `SELECT public.daily_record_participation($1, date_trunc('hour', now()), 0) r`;
    const { ra, rb, esperou } = await corrida(sql, [u], sql, [u]);
    eq(esperou, true, "B não esperou (não houve simultaneidade)");
    eq(rb.erro?.message ?? null, null, "B deu erro");
    eq(await linhas(u, "first_daily"), 1, "linhas first_daily");
    eq([ra.r.unlocked, rb.ok.r.unlocked], [["first_daily"], []], "relatos");
  });

  await t("A2. 2 conexões, caminhos DIFERENTES (escolha segura × juiz): 1 linha; juiz sem erro e sem relistar", async () => {
    const u = await novoUsuario();
    const { ra, rb, esperou } = await corrida(
      `SELECT public.daily_record_participation($1, date_trunc('hour', now()), 0) r`,
      [u],
      `SELECT public.submit_daily_attempt_scored($1, 'corrida', 10, 95) r`,
      [u],
    );
    eq(esperou, true, "o juiz não esperou");
    eq(rb.erro?.message ?? null, null, "juiz deu erro");
    eq(await linhas(u, "first_daily"), 1, "linhas first_daily");
    eq(ra.r.unlocked, ["first_daily"], "escolha relata");
    eq(rb.ok.r.unlocked.includes("first_daily"), false, "juiz relistou");
  });

  await t("A3. rajada: 8 conexões ao mesmo tempo, mesma conquista → 1 linha, 0 erros, 1 relato", async () => {
    const u = await novoUsuario();
    const cs = await Promise.all(Array.from({ length: 8 }, () => conn()));
    const rs = await Promise.allSettled(
      cs.map((c) => c.query(`SELECT public.daily_record_participation($1, date_trunc('hour', now()), 0) r`, [u])),
    );
    eq(rs.filter((r) => r.status === "rejected").map((r) => r.reason.message), [], "erros");
    eq(rs.filter((r) => r.value.rows[0].r.unlocked.includes("first_daily")).length, 1, "relatos");
    eq(await linhas(u, "first_daily"), 1, "linhas");
  });

  await t("A4. sequência: 3ª participação concorrente concede Em Chamas uma vez só (streak_3 sob corrida)", async () => {
    const u = await novoUsuario();
    // já jogou anteontem e ontem (Brasília) → hoje = 3º dia
    await q(
      `UPDATE public.user_stats SET current_streak = 2, best_streak = 2,
              last_played_date = (date_trunc('hour', now()) AT TIME ZONE 'America/Sao_Paulo')::date - 1
        WHERE user_id = $1`,
      [u],
    );
    await q(`INSERT INTO public.user_achievements (user_id, achievement_code) VALUES ($1, 'first_daily')`, [u]);
    const sql = `SELECT public.daily_record_participation($1, date_trunc('hour', now()), 0) r`;
    const { ra, rb, esperou } = await corrida(sql, [u], sql, [u]);
    eq(esperou, true, "B não esperou");
    eq(rb.erro?.message ?? null, null, "B deu erro");
    eq([ra.r.current_streak, rb.ok.r.current_streak], [3, 3], "sequência");
    eq([ra.r.unlocked, rb.ok.r.unlocked], [["streak_3"], []], "relatos");
    eq(await linhas(u, "streak_3"), 1, "linhas streak_3");
  });

  // ---------------------------------------------------------------- B) controle do arranjo
  await t("B1. CONTROLE: o mesmo arranjo derruba concessão SEM ON CONFLICT (unique_violation); COM ON CONFLICT passa", async () => {
    await main.query(`
      CREATE FUNCTION public.${zz[0]}(p uuid) RETURNS boolean LANGUAGE plpgsql AS $f$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p AND achievement_code = 'first_daily') THEN
          INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p, 'first_daily');
          RETURN true;
        END IF;
        RETURN false;
      END $f$;
      CREATE FUNCTION public.${zz[1]}(p uuid) RETURNS boolean LANGUAGE plpgsql AS $f$
      BEGIN
        INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p, 'first_daily')
        ON CONFLICT (user_id, achievement_code) DO NOTHING;
        RETURN FOUND;
      END $f$;
      REVOKE ALL ON FUNCTION public.${zz[0]}(uuid) FROM PUBLIC, anon, authenticated;
      REVOKE ALL ON FUNCTION public.${zz[1]}(uuid) FROM PUBLIC, anon, authenticated;`);
    const u1 = await novoUsuario();
    const sem = `SELECT public.${zz[0]}($1) r`;
    const r1 = await corrida(sem, [u1], sem, [u1]);
    eq(r1.esperou, true, "sem ON CONFLICT: B não esperou");
    eq(r1.rb.erro?.code ?? null, "23505", "sem ON CONFLICT devia dar unique_violation");
    const u2 = await novoUsuario();
    const com = `SELECT public.${zz[1]}($1) r`;
    const r2 = await corrida(com, [u2], com, [u2]);
    eq(r2.esperou, true, "com ON CONFLICT: B não esperou");
    eq([r2.rb.erro?.message ?? null, r2.ra.r, r2.rb.ok?.r], [null, true, false], "com ON CONFLICT");
    eq(await linhas(u2, "first_daily"), 1, "linhas");
  });

  // ---------------------------------------------------------------- C) rollback ensaiado (transação desfeita)
  await t("C1. ROLLBACK: preserva progresso de depois da migration e continua a sequência em horas (ensaio desfeito)", async () => {
    const u = await novoUsuario(); // backup em horas 2/7 (15:00Z); depois da migration jogou 16:00Z e 17:00Z
    const u2 = await novoUsuario(); // backup 3/12, não jogou depois → volta exatamente ao backup
    const snap = async () =>
      (
        await q(`SELECT
          (SELECT md5(string_agg((to_jsonb(s) - 'current_streak' - 'best_streak' - 'last_played_date'
                                  - 'last_played_hour' - 'updated_at')::text, '|' ORDER BY s.user_id))
             FROM public.user_stats s) AS progresso,
          (SELECT md5(string_agg(to_jsonb(a)::text, '|' ORDER BY a.id)) FROM public.user_achievements a) AS conquistas,
          (SELECT md5(string_agg(to_jsonb(d)::text, '|' ORDER BY d.id)) FROM public.daily_attempts d) AS tentativas`)
      )[0];
    await main.query("BEGIN");
    try {
      await q(
        `INSERT INTO public.conquistas_streak_horas_bkp (user_id, current_streak, best_streak, last_played_date, last_played_hour, salvo_em)
         VALUES ($1, 2, 7, '2026-11-05', '2026-11-05T15:00Z', now() - interval '1 hour'),
                ($2, 3, 12, NULL, NULL, now() - interval '1 hour')`,
        [u, u2],
      );
      await q(`UPDATE public.user_stats SET current_streak = 1, best_streak = 3, last_played_date = '2026-11-05',
                      last_played_hour = '2026-11-05T15:00Z', total_score = 321, xp = 450, games_played = 4 WHERE user_id = $1`, [u]);
      for (const h of ["2026-11-05T16:00Z", "2026-11-05T17:00Z"]) {
        await q(
          `INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, score, mode)
           VALUES ($1, ($2::timestamptz)::date, $2::timestamptz, 'x', 10, 'escolha')`,
          [u, h],
        );
        await q(`SELECT public.daily_record_participation($1, $2::timestamptz, 10)`, [u, h]);
      }
      await q(`INSERT INTO public.user_achievements (user_id, achievement_code) VALUES ($1, 'big_score')`, [u]);
      const antes = await snap();
      await main.query(RB);
      eq(await snap(), antes, "XP/pontuação/estatísticas, conquistas ou tentativas mudaram");
      const st = async (id) =>
        (await q(`SELECT current_streak c, best_streak b, last_played_date::text d, last_played_hour h FROM public.user_stats WHERE user_id = $1`, [id]))[0];
      const s = await st(u);
      eq([s.c, s.b, s.d, s.h.toISOString()], [4, 7, "2026-11-05", "2026-11-05T17:00:00.000Z"], "u = backup 2 + 16h + 17h");
      const s2 = await st(u2);
      eq([s2.c, s2.b], [3, 12], "u2 = backup");
      eq((await md5Pontuacao()).slice(0, 8), "e41b8c87", "corpo de produção da pontuação");
      eq((await q(`SELECT to_regclass('public.conquistas_streak_horas_bkp') IS NULL r`))[0].r, true, "backup removido");
      const r = (await q(`SELECT public.daily_record_participation($1, '2026-11-05T18:00Z'::timestamptz, 0) r`, [u]))[0].r;
      eq(r.current_streak, 5, "função antiga continua a sequência (18h = +1)");
    } finally {
      await main.query("ROLLBACK");
    }
    eq(await md5Pontuacao(), md5Inicial, "ensaio não foi desfeito (corpo)");
    eq((await q(`SELECT to_regclass('public.conquistas_streak_horas_bkp') IS NOT NULL r`))[0].r, true, "ensaio não foi desfeito (backup)");
  });
} finally {
  for (const f of zz) await q(`DROP FUNCTION IF EXISTS public.${f}(uuid)`).catch(() => {});
  if (criados.length) {
    await q(`DELETE FROM public.daily_attempts WHERE user_id = ANY($1::uuid[])`, [criados]);
    await q(`DELETE FROM public.user_achievements WHERE user_id = ANY($1::uuid[])`, [criados]);
    await q(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [criados]);
  }
  await Promise.all(abertas.map((c) => c.end().catch(() => {})));
}
console.log(`\n${pass} passaram, ${fail} falharam${fail ? ": " + falhas.join(" | ") : ""}`);
process.exitCode = fail ? 1 : 0;
