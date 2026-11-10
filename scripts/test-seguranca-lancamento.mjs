// Segurança/estabilidade do lançamento (10/11/2026): migrations
//   20261111090000_room_code_sem_colisao   — código de sala sem colisão
//   20261111090100_anon_rpc_endurecimento  — log_ops_event com teto; chat dormente fechado
// com conexões REAIS independentes (a corrida do código só existe entre sessões).
//
//   node scripts/test-seguranca-lancamento.mjs
//       CI: Supabase local já migrado (DB_URL). Prova o comportamento novo.
//   node scripts/test-seguranca-lancamento.mjs --esquema-minimo [--antes]
//       Postgres LOCAL VAZIO: cria o esquema mínimo (rooms, players, ops_events,
//       papéis, auth.uid) e instala as funções. --antes instala as de ANTES
//       (os arquivos de rollback) — o tripwire: as provas de colisão FALHAM.
//
// Tudo que grava fica numa transação desfeita, exceto a corrida (precisa de
// COMMIT entre sessões): as salas dela são apagadas no fim, aconteça o que
// acontecer. Recusa qualquer DB_URL que não seja local.
import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const MIG_CODE = rd("supabase/migrations/20261111090000_room_code_sem_colisao.sql");
const MIG_ANON = rd("supabase/migrations/20261111090100_anon_rpc_endurecimento.sql");
const RB_CODE = rd("supabase/rollback/room_code_sem_colisao.sql");
const RB_ANON = rd("supabase/rollback/anon_rpc_endurecimento.sql");
// md5(prosrc) em PRODUÇÃO antes destas migrations (catálogo, 10/11/2026 22:5xZ):
// o rollback precisa devolver exatamente estes corpos.
const PROD_MD5 = {
  create_room_with_host: "6d3bf9737f3f9625cc1b3d7d6bdd45a0",
  join_public_room: "0bbd4d65d27b341ce72009b19c1c1fb0",
  log_ops_event: "c259daaf6cdc0c00a82952b7e3f2c896",
};

const args = process.argv.slice(2);
const minimo = args.includes("--esquema-minimo");
const antes = args.includes("--antes");
const { DB_URL } = process.env;
if (!DB_URL) {
  console.error("✖ DB_URL ausente: este teste precisa de um Postgres real.");
  process.exit(1);
}
const host = new URL(DB_URL).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  console.error(`✖ recusado: DB_URL aponta para "${host}". Este teste grava e só roda em banco LOCAL.`);
  process.exit(1);
}

const conn = async () => {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  return c;
};
const db = await conn();
const q = async (s, p = []) => (await db.query(s, p)).rows;
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
};
const tag = Math.random().toString(36).slice(2, 8);
const claims = (uid) => `SET LOCAL request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'`;

// ---------------------------------------------------------------- esquema mínimo
if (minimo) {
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
  if (n > 0) {
    console.error("✖ --esquema-minimo exige banco VAZIO (há tabelas em public).");
    process.exit(1);
  }
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                             (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
    CREATE TABLE public.rooms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      host_id text NOT NULL,
      status text NOT NULL DEFAULT 'lobby',
      visibility text NOT NULL DEFAULT 'private',
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.players (
      id text PRIMARY KEY,
      room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
      nickname text NOT NULL, avatar text NOT NULL DEFAULT 'x', color text NOT NULL DEFAULT '#000',
      is_connected boolean NOT NULL DEFAULT true, user_id uuid, kicked_at timestamptz);
    CREATE TABLE public.ops_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
      kind text NOT NULL, build text, session_key text, room_hash text, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE INDEX ops_events_at_idx ON public.ops_events (at DESC);
    CREATE INDEX ops_events_session_at_idx ON public.ops_events (session_key, at DESC);
    CREATE OR REPLACE FUNCTION public.is_sessionless_api_call() RETURNS boolean LANGUAGE sql STABLE
      SET search_path TO 'public' AS $$
      SELECT auth.uid() IS NULL AND COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated'); $$;
    CREATE OR REPLACE FUNCTION public.is_player_banned(p text, u uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    -- a RPC dormente: só a assinatura e as permissões de produção importam aqui
    CREATE OR REPLACE FUNCTION public.send_room_message(p_room_id uuid, p_player_id text, p_text text)
      RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT '{"ok":true}'::jsonb $$;
    GRANT EXECUTE ON FUNCTION public.send_room_message(uuid, text, text) TO PUBLIC, anon, authenticated, service_role;
  `);
  // "antes" = rollback (corpos de produção); "depois" = rollback + migrations.
  await db.query(RB_CODE);
  await db.query(RB_ANON);
  if (!antes) {
    await db.query(MIG_CODE);
    await db.query(MIG_ANON);
  }
  console.log(`esquema mínimo pronto (${antes ? "ANTES — funções de produção" : "DEPOIS — migrations novas"})`);
  // O que o rollback instala é o que está em produção?
  const md5 = Object.fromEntries(
    (await q(`SELECT proname, md5(prosrc) AS m FROM pg_proc WHERE pronamespace = 'public'::regnamespace
               AND proname = ANY($1)`, [Object.keys(PROD_MD5)])).map((r) => [r.proname, r.m]),
  );
  if (antes) {
    for (const [f, m] of Object.entries(PROD_MD5)) check(`rollback = produção: ${f}`, md5[f] === m, md5[f]);
  }
}

// ------------------------------------------------------------------ utilidades
const codesTaken = async (c = db) =>
  new Set((await c.query(`SELECT code FROM public.rooms WHERE code ~ '^[0-9]{4}$'`)).rows.map((r) => r.code));
/** Ocupa todos os códigos de 4 dígitos, menos `free` sorteados entre os livres. */
async function fillLeaving(c, free, hostPrefix) {
  const taken = await codesTaken(c);
  const livres = [];
  for (let i = 1000; i <= 9999; i++) if (!taken.has(String(i))) livres.push(String(i));
  livres.sort(() => Math.random() - 0.5);
  const keep = new Set(livres.slice(0, free));
  const fill = livres.filter((x) => !keep.has(x));
  await c.query(
    `INSERT INTO public.rooms (code, host_id, status)
     SELECT x, $2 || x, 'finished' FROM unnest($1::text[]) AS x`,
    [fill, hostPrefix],
  );
  return keep;
}
const errCode = (e) => String(e?.message ?? e);

// --------------------------------------------- 1) criação com a tabela quase cheia
{
  await db.query("BEGIN");
  try {
    const free = await fillLeaving(db, 5, `rcfill_${tag}_`);
    await db.query(claims(randomUUID()));
    const got = [];
    let err = null;
    for (let i = 0; i < 5 && !err; i++) {
      await db.query("SAVEPOINT s");
      try {
        const [r] = await q(`SELECT code FROM public.create_room_with_host($1, 'Teste', 'x', '#000')`, [`rc_${tag}_s${i}`]);
        got.push(r.code);
        await db.query("RELEASE SAVEPOINT s");
      } catch (e) {
        err = errCode(e);
        await db.query("ROLLBACK TO SAVEPOINT s");
      }
    }
    check("5 códigos livres em 9.000 → as 5 criações dão certo", got.length === 5 && !err, err ?? got.join(","));
    check("os 5 códigos são exatamente os livres", got.every((x) => free.has(x)) && new Set(got).size === got.length);
    let sexta = null;
    try {
      await q(`SELECT public.create_room_with_host($1, 'Teste', 'x', '#000')`, [`rc_${tag}_s6`]);
    } catch (e) {
      sexta = errCode(e);
    }
    check("com os 9.000 ocupados → erro claro, sem laço infinito", /could not generate unique room code/.test(sexta ?? ""), sexta ?? "criou?!");
  } finally {
    await db.query("ROLLBACK");
  }
}

// ---------------------------------------- 2) join_public_room criando lobby público
{
  await db.query("BEGIN");
  try {
    // nenhum lobby público aberto nesta transação: força a criação
    await db.query(`UPDATE public.rooms SET status = 'finished' WHERE visibility = 'public' AND status = 'lobby'`);
    await fillLeaving(db, 3, `rcfill_${tag}_`);
    await db.query(claims(randomUUID()));
    const got = [];
    let err = null;
    for (let i = 0; i < 3 && !err; i++) {
      await db.query("SAVEPOINT s");
      try {
        const [r] = await q(`SELECT id, code FROM public.join_public_room($1, 'Teste', 'x', '#000')`, [`rc_${tag}_j${i}`]);
        got.push(r.code);
        // o lobby criado sai da fila (senão a próxima entrada entraria nele)
        await db.query(`UPDATE public.rooms SET status = 'writing' WHERE id = $1`, [r.id]);
        await db.query("RELEASE SAVEPOINT s");
      } catch (e) {
        err = errCode(e);
        await db.query("ROLLBACK TO SAVEPOINT s");
      }
    }
    check("partida rápida: 3 lobbies públicos com 3 códigos livres", got.length === 3 && !err, err ?? got.join(","));
  } finally {
    await db.query("ROLLBACK");
  }
}

// ------------------------------------------- 3) corrida real: N sessões ao mesmo tempo
{
  const N = 16;
  const prefix = `rcfill_${tag}_`;
  const made = [];
  const sessions = [];
  try {
    await fillLeaving(db, N, prefix); // COMMIT implícito: as outras sessões precisam ver
    for (let i = 0; i < N; i++) sessions.push(await conn());
    const res = await Promise.allSettled(
      sessions.map(async (c, i) => {
        await c.query("BEGIN");
        try {
          await c.query(claims(randomUUID()));
          const { rows } = await c.query(
            `SELECT id, code FROM public.create_room_with_host($1, 'Corrida', 'x', '#000')`,
            [`rc_${tag}_c${i}`],
          );
          await c.query("COMMIT");
          made.push(rows[0].id);
          return rows[0].code;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      }),
    );
    const ok = res.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const bad = res.filter((r) => r.status === "rejected").map((r) => errCode(r.reason));
    check(`${N} criações SIMULTÂNEAS com ${N} códigos livres → todas dão certo`, ok.length === N, bad.slice(0, 3).join(" | "));
    check("nenhum código repetido", new Set(ok).size === ok.length);
    check("nenhuma unique_violation chega ao cliente", !bad.some((m) => /duplicate key|rooms_code_key/.test(m)), bad.find((m) => /duplicate/.test(m)) ?? "");
  } finally {
    for (const c of sessions) await c.end().catch(() => {});
    if (made.length) await db.query(`DELETE FROM public.players WHERE room_id = ANY($1::uuid[])`, [made]);
    if (made.length) await db.query(`DELETE FROM public.rooms WHERE id = ANY($1::uuid[])`, [made]);
    await db.query(`DELETE FROM public.rooms WHERE host_id LIKE $1`, [`${prefix}%`]);
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM public.rooms WHERE host_id LIKE $1`, [`${prefix}%`]);
    check("limpeza da corrida (nenhuma sala de enchimento sobra)", n === 0, `n=${n}`);
  }
}

// ------------------- 3b) corrida PURA: mesmo sorteio em todas as sessões (setseed)
// Tabela com folga; cada sessão sorteia a MESMA sequência de códigos, então
// todas passam pela checagem "código livre?" juntas e disputam o INSERT. Antes:
// só uma criava, as outras levavam unique_violation (rooms_code_key) crua.
{
  const N = 8;
  const made = [];
  const sessions = [];
  try {
    for (let i = 0; i < N; i++) sessions.push(await conn());
    const res = await Promise.allSettled(
      sessions.map(async (c, i) => {
        await c.query("BEGIN");
        try {
          await c.query(claims(randomUUID()));
          await c.query("SELECT setseed(0.4242)");
          const { rows } = await c.query(
            `SELECT id, code FROM public.create_room_with_host($1, 'Corrida', 'x', '#000')`,
            [`rc_${tag}_p${i}`],
          );
          await c.query("COMMIT");
          made.push(rows[0].id);
          return rows[0].code;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      }),
    );
    const ok = res.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const bad = res.filter((r) => r.status === "rejected").map((r) => errCode(r.reason));
    check(`corrida pura: ${N} sessões com o mesmo sorteio → todas criam`, ok.length === N, bad.slice(0, 2).join(" | "));
    check("corrida pura: nenhuma unique_violation crua", !bad.some((m) => /duplicate key|rooms_code_key/.test(m)), bad[0] ?? "");
    check("corrida pura: códigos distintos", new Set(ok).size === ok.length);
  } finally {
    for (const c of sessions) await c.end().catch(() => {});
    if (made.length) await db.query(`DELETE FROM public.players WHERE room_id = ANY($1::uuid[])`, [made]);
    if (made.length) await db.query(`DELETE FROM public.rooms WHERE id = ANY($1::uuid[])`, [made]);
  }
}

// --------------------------------------------------------- 4) log_ops_event com teto
if (!antes) {
  await db.query("BEGIN");
  try {
    const big = { message: "x".repeat(5000) };
    await db.query(`SELECT public.log_ops_event('client_error', $1::jsonb, $2, NULL, 'teste')`, [JSON.stringify(big), `ops_${tag}_big`]);
    const [b] = await q(`SELECT payload FROM public.ops_events WHERE session_key = $1`, [`ops_${tag}_big`]);
    check("payload > 2 kB vira resumo (truncated)", b?.payload?.truncated === true && !b?.payload?.message, JSON.stringify(b?.payload ?? null).slice(0, 80));
    const small = { message: "erro real", stack: "at x".repeat(200), route: "/sala" };
    await db.query(`SELECT public.log_ops_event('client_error', $1::jsonb, $2, NULL, 'teste')`, [JSON.stringify(small), `ops_${tag}_ok`]);
    const [s] = await q(`SELECT payload FROM public.ops_events WHERE session_key = $1`, [`ops_${tag}_ok`]);
    check("payload do tamanho do client real fica inteiro", s?.payload?.message === "erro real");

    // A cota conta só os 4 tipos do client: eventos do servidor sem session_key
    // (bot_ai_error, stalled_advance…) não entram. Na CI o banco é compartilhado:
    // compara com o que já existe NA JANELA, e semeia de propósito eventos dos dois
    // tipos para provar que o teto é da janela, não só das chamadas deste teste.
    const semSessaoCli = `SELECT count(*)::int AS n FROM public.ops_events WHERE session_key IS NULL AND kind IN ('client_error', 'boundary_crash', 'rpc_failure', 'reconnect') AND at > now() - interval '1 minute'`;
    await db.query(`INSERT INTO public.ops_events (kind, payload) SELECT 'client_error', '{}'::jsonb FROM generate_series(1, 20)`);
    await db.query(`INSERT INTO public.ops_events (kind, payload) SELECT 'bot_ai_error', '{}'::jsonb FROM generate_series(1, 25)`);
    const [{ n: base }] = await q(semSessaoCli);
    for (let i = 0; i < 70; i++) await db.query(`SELECT public.log_ops_event('reconnect', '{}'::jsonb, NULL, NULL, $1)`, [`t${tag}`]);
    const [{ n: semSessao }] = await q(semSessaoCli);
    const [{ n: deste }] = await q(`SELECT count(*)::int AS n FROM public.ops_events WHERE build = $1`, [`t${tag}`]);
    check("sem session_key: teto de 60/min CONTANDO o que já havia na janela", base >= 20 && semSessao === Math.max(60, base) && deste === Math.max(0, 60 - base), `já havia=${base} depois=${semSessao} aceitas=${deste}`);

    // trocar a chave a cada chamada não fura o teto global (300/min)
    await db.query(`INSERT INTO public.ops_events (kind, session_key) SELECT 'reconnect', 'ops_${tag}_g' || g FROM generate_series(1, 300) g`);
    await db.query(`SELECT public.log_ops_event('reconnect', '{}'::jsonb, $1, NULL, 'teste')`, [`ops_${tag}_nova`]);
    const [{ n: nova }] = await q(`SELECT count(*)::int AS n FROM public.ops_events WHERE session_key = $1`, [`ops_${tag}_nova`]);
    check("teto global 300/min vale para chave nova", nova === 0, `n=${nova}`);
  } finally {
    await db.query("ROLLBACK");
  }
  await db.query("BEGIN");
  try {
    // eventos do SERVIDOR (gravados direto) não consomem a cota do client
    await db.query(`INSERT INTO public.ops_events (kind, at) SELECT 'data_retention', now() - interval '30 minutes' FROM generate_series(1, 3000) g`);
    await db.query(`SELECT public.log_ops_event('reconnect', '{}'::jsonb, $1, NULL, 'teste')`, [`ops_${tag}_srv`]);
    const [{ n: srv }] = await q(`SELECT count(*)::int AS n FROM public.ops_events WHERE session_key = $1`, [`ops_${tag}_srv`]);
    check("eventos do servidor não esgotam a cota do client", srv === 1, `n=${srv}`);
    await db.query(`INSERT INTO public.ops_events (kind, session_key, at) SELECT 'reconnect', 'ops_${tag}_h' || g, now() - interval '30 minutes' FROM generate_series(1, 1000) g`);
    await db.query(`SELECT public.log_ops_event('reconnect', '{}'::jsonb, $1, NULL, 'teste')`, [`ops_${tag}_hora`]);
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM public.ops_events WHERE session_key = $1`, [`ops_${tag}_hora`]);
    check("teto global 1.000/hora", n === 0, `n=${n}`);
  } finally {
    await db.query("ROLLBACK");
  }
  await db.query("BEGIN");
  try {
    await db.query(`INSERT INTO public.ops_events (kind, session_key, at) SELECT 'client_error', 'ops_${tag}_d' || g, now() - interval '12 hours' FROM generate_series(1, 2000) g`);
    await db.query(`SELECT public.log_ops_event('reconnect', '{}'::jsonb, $1, NULL, 'teste')`, [`ops_${tag}_dia`]);
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM public.ops_events WHERE session_key = $1`, [`ops_${tag}_dia`]);
    check("teto global 2.000/dia (pior caso ≈ 120 MB em 30 dias)", n === 0, `n=${n}`);
  } finally {
    await db.query("ROLLBACK");
  }

  // ------------------------------------------------------ 5) permissões
  const priv = async (role, sig) =>
    (await q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS x`, [role, sig]))[0].x;
  const chat = "public.send_room_message(uuid, text, text)";
  check("chat dormente: anon NÃO executa send_room_message", (await priv("anon", chat)) === false);
  check("chat dormente: authenticated NÃO executa send_room_message", (await priv("authenticated", chat)) === false);
  check("telemetria segue aberta ao client (anon executa log_ops_event)", (await priv("anon", "public.log_ops_event(text, jsonb, text, text, text)")) === true);
  check("criar sala segue aberto (anon executa create_room_with_host)", (await priv("anon", "public.create_room_with_host(text, text, text, text)")) === true);

  // ------------------------------------------- 6) rollback devolve produção byte a byte
  await db.query("BEGIN");
  try {
    await db.query(RB_CODE);
    await db.query(RB_ANON);
    const md5 = Object.fromEntries(
      (await q(`SELECT proname, md5(prosrc) AS m FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                 AND proname = ANY($1)`, [Object.keys(PROD_MD5)])).map((r) => [r.proname, r.m]),
    );
    for (const [f, m] of Object.entries(PROD_MD5)) check(`rollback devolve o corpo de produção: ${f}`, md5[f] === m, md5[f]);
    check("rollback reabre send_room_message (como em produção)", (await priv("anon", chat)) === true);
  } finally {
    await db.query("ROLLBACK");
  }
}

await db.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
