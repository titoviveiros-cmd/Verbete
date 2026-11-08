// Diário D1 — modo ESCOLHA: testes SQL da migration 20261108120000_diario_d1_escolha.sql.
// Critérios (CRITERIOS-ACEITE-DIARIO-D1.md): 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 21 (+ rollback).
//
// Dois modos (mesmo padrão de test-daily-guard.mjs):
//   node scripts/test-daily-choice.mjs --pglite <pasta do @electric-sql/pglite>
//       Offline: Postgres embutido (1 conexão). Monta o esquema MÍNIMO com as funções
//       REAIS (copiadas das migrations), aplica a V2 e o D1 e compara ANTES × DEPOIS.
//   DB_URL=postgres://…127.0.0.1… node scripts/test-daily-choice.mjs        (CI)
//       Supabase local já migrado: roda também as corridas com conexões independentes.
//       Sem DB_URL = FALHA. Só aceita banco LOCAL. Restaura o que mexe (modo, desafio da hora).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const D1 = rd("supabase/migrations/20261108120000_diario_d1_escolha.sql");
const D1_ROLLBACK = rd("supabase/rollback/diario_d1_escolha.sql");

const args = process.argv.slice(2);
const pglitePath = args.includes("--pglite") ? args[args.indexOf("--pglite") + 1] : null;
const modePg = !pglitePath;
const DB_URL = process.env.DB_URL ?? process.env.DATABASE_URL;
if (modePg) {
  if (!DB_URL) {
    console.error("✖ DB_URL ausente: este teste NÃO pode passar sem um Postgres real (use --pglite só para o ensaio local).");
    process.exit(1);
  }
  const host = new URL(DB_URL).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    console.error(`✖ recusado: DB_URL aponta para "${host}". Este teste altera dados e só roda em banco LOCAL.`);
    process.exit(1);
  }
}

let db;
if (modePg) {
  const { default: pg } = await import("pg");
  const mk = async () => {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    return c;
  };
  const main = await mk();
  db = { q: async (s, p = []) => (await main.query(s, p)).rows, exec: (s) => main.query(s), close: () => main.end(), conn: mk };
} else {
  const { PGlite } = await import(pathToFileURL(join(pglitePath, "dist", "index.js")).href);
  const pgl = await PGlite.create();
  db = { q: async (s, p = []) => (await pgl.query(s, p)).rows, exec: (s) => pgl.exec(s), close: () => pgl.close(), conn: null };
}

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
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" && !(v instanceof Date)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const eq = (a, b, msg) => {
  if (JSON.stringify(canon(a)) !== JSON.stringify(canon(b))) throw new Error(`${msg ?? "diferente"}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
};
const ok = (v, msg) => {
  if (!v) throw new Error(msg ?? "falso");
};
/** D-c (espelho do TS em src/lib/daily-choice.ts): o SQL tem de bater. */
const pontos = (t) => Math.max(Math.round(Math.max(100 - Math.min(600, Math.max(0, Math.floor(t))), 20) * 0.5), 10);

// ---------------------------------------------------------------------------
// Virada de hora no meio do teste deixaria tudo instável: espera a hora nova.
// ---------------------------------------------------------------------------
{
  const [{ s }] = await db.q(`SELECT extract(epoch FROM (date_trunc('hour', now()) + interval '1 hour' - now()))::int AS s`);
  if (s < 150) {
    console.log(`(faltam ${s}s para a virada da hora: esperando a hora nova)`);
    await new Promise((r) => setTimeout(r, (s + 3) * 1000));
  }
}

// ---------------------------------------------------------------------------
// Esquema mínimo (só PGlite) com as funções REAIS das migrations
// ---------------------------------------------------------------------------
function fnBlock(src, start, endMark) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`não achei: ${start}`);
  const j = src.indexOf(endMark, i);
  return src.slice(i, j + endMark.length);
}
let md5Antes = null;
let estadoAntes = null;
if (!modePg) {
  const SCORING = fnBlock(rd("supabase/migrations/20260608161016_4a498957-8605-4dfc-a9cd-494245ccb841.sql"),
    "CREATE OR REPLACE FUNCTION public.submit_daily_attempt_scored", "$function$;");
  const CHALLENGE = fnBlock(rd("supabase/migrations/20260520092654_55294501-70f9-44a5-bf55-59c2cc5ebad8.sql"),
    "CREATE OR REPLACE FUNCTION public.get_or_create_daily_challenge", "$function$;");
  const REVIEW = fnBlock(rd("supabase/migrations/20260520093449_2ae8b890-935f-4b0c-9f1d-6bc2b62f8f1b.sql"),
    "CREATE OR REPLACE FUNCTION public.get_my_daily_review", "$function$;");
  const BOARD = fnBlock(rd("supabase/migrations/20260519024511_5e20e2b8-e00c-4c23-8e4a-d186aa14433d.sql"),
    "CREATE OR REPLACE FUNCTION public.get_daily_leaderboard", "$$;");
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA extensions;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, is_anonymous boolean NOT NULL DEFAULT false);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    CREATE TABLE public.app_config (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION public.get_app_config(p_key text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path TO 'public' AS $$ SELECT value FROM public.app_config WHERE key = p_key; $$;
    CREATE TABLE public.ops_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
      kind text NOT NULL, build text, session_key text, room_hash text, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE public.words (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), word text NOT NULL UNIQUE, meaning text NOT NULL,
      category text, rarity int NOT NULL DEFAULT 2, classe text, status text NOT NULL DEFAULT 'published');
    CREATE TABLE public.daily_challenges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), challenge_date date,
      challenge_hour timestamptz NOT NULL UNIQUE, word_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.daily_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      challenge_date date, challenge_hour timestamptz NOT NULL, guess text NOT NULL, is_correct boolean NOT NULL DEFAULT false,
      score integer NOT NULL DEFAULT 0, time_seconds integer NOT NULL DEFAULT 0, similarity integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT daily_attempts_user_challenge_hour_key UNIQUE (user_id, challenge_hour));
    ALTER TABLE public.daily_attempts ENABLE ROW LEVEL SECURITY;
    CREATE TABLE public.user_stats (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      current_streak integer NOT NULL DEFAULT 0, best_streak integer NOT NULL DEFAULT 0, last_played_date date,
      last_played_hour timestamptz, total_score integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.user_achievements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      achievement_code text NOT NULL, unlocked_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, achievement_code));
    ${SCORING}
    ${CHALLENGE}
    ${REVIEW}
    ${BOARD}
    GRANT EXECUTE ON FUNCTION public.get_my_daily_review() TO authenticated;
    GRANT EXECUTE ON FUNCTION public.get_daily_leaderboard(integer) TO authenticated;
  `);
  await db.exec(rd("supabase/migrations/20261105150000_daily_guard_v2.sql"));
  // histórico ANTES do D1: uma tentativa antiga e as estatísticas de um jogador
  const old = randomUUID();
  await db.q(`INSERT INTO auth.users (id) VALUES ($1)`, [old]);
  await db.q(`INSERT INTO public.words (word, meaning, rarity) VALUES ('palavra-antiga', 'definição antiga', 3)`);
  await db.q(`INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, is_correct, score, time_seconds, similarity)
              VALUES ($1, '2026-01-01', '2026-01-01 10:00+00', 'palpite', true, 77, 12, 91)`, [old]);
  await db.q(`INSERT INTO public.user_stats (user_id, current_streak, best_streak, last_played_hour, total_score)
              VALUES ($1, 3, 9, '2026-01-01 10:00+00', 1234)`, [old]);
  // como em produção (handle_new_user, migration 20261027200100): criar o usuário já cria user_stats
  await db.exec(`
    CREATE FUNCTION public.handle_new_user_stats() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
      $f$ BEGIN INSERT INTO public.user_stats (user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING; RETURN NEW; END $f$;
    CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_stats();`);
  md5Antes = (await db.q(`SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'submit_daily_attempt_scored'`))[0].m;
  estadoAntes = await db.q(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS m FROM (
      SELECT user_id, current_streak, best_streak, last_played_hour, total_score FROM public.user_stats) t`);
  await db.exec(D1);
}

console.log(`Diário D1 (modo escolha) — modo ${modePg ? "pg (Postgres real)" : "PGlite (offline, 1 conexão)"}`);

// ---------------------------------------------------------------------------
// Utilidades e fixtures
// ---------------------------------------------------------------------------
const tag = Math.random().toString(36).slice(2, 8);
const HORA = (await db.q(`SELECT date_trunc('hour', now()) AS h`))[0].h;
const modoAntes = (await db.q(`SELECT value FROM public.app_config WHERE key = 'daily_mode'`))[0]?.value ?? null;
const desafioAntes = (await db.q(`SELECT * FROM public.daily_challenges WHERE challenge_hour = $1`, [HORA]))[0] ?? null;
const usuarios = [];
const palavras = [];

const novoUsuario = async () => {
  const id = randomUUID();
  usuarios.push(id);
  await db.q(`INSERT INTO auth.users (id, is_anonymous) VALUES ($1, false)`, [id]);
  return id;
};
/**
 * Estado de user_stats do jogador de teste, definido POR COMPLETO. Em produção a linha já
 * existe (o gatilho handle_new_user a cria junto com o usuário), então é upsert: um INSERT
 * puro colidia com user_stats_pkey (CI 42500287456). Não toca nenhuma função do D1.
 */
const definirStats = (u, { streak = 0, best = 0, horasAtras = null, total = 0 } = {}) =>
  db.q(
    `INSERT INTO public.user_stats (user_id, current_streak, best_streak, last_played_hour, total_score)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE $5::timestamptz - make_interval(hours => $4::int) END, $6)
     ON CONFLICT (user_id) DO UPDATE SET current_streak = EXCLUDED.current_streak, best_streak = EXCLUDED.best_streak,
       last_played_hour = EXCLUDED.last_played_hour, total_score = EXCLUDED.total_score, updated_at = now()`,
    [u, streak, best, horasAtras, HORA, total],
  );
const setModo = (m) =>
  db.q(`INSERT INTO public.app_config (key, value) VALUES ('daily_mode', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [m]);
const novaPalavra = async (n, { status = "published", conjunto = "aprovado", meaning } = {}) => {
  const m = meaning ?? `Definição de teste número ${n} ${tag}`;
  const [{ id }] = await db.q(
    `INSERT INTO public.words (word, meaning, rarity, status) VALUES ($1, $2, 3, $3) RETURNING id`,
    [`d1t_${tag}_${n}`, m, status],
  );
  palavras.push(id);
  if (conjunto)
    await db.q(
      `INSERT INTO public.daily_choice_sets (word_id, distractors, truth_snapshot, status, validacao)
       VALUES ($1, $2, $3, $4, '{"ok":true,"issues":[]}')`,
      [id, [`Distrator A ${n} ${tag}`, `Distrator B ${n} ${tag}`, `Distrator C ${n} ${tag}`], m, conjunto],
    );
  return { id, meaning: m };
};
const forcarDesafio = async (wordId) => {
  await db.q(`DELETE FROM public.daily_challenges WHERE challenge_hour = $1`, [HORA]);
  if (wordId)
    await db.q(`INSERT INTO public.daily_challenges (challenge_date, challenge_hour, word_id) VALUES ($1::timestamptz::date, $1::timestamptz, $2)`, [HORA, wordId]);
};
const start = async (u) => (await db.q(`SELECT public.daily_choice_start($1) AS r`, [u]))[0].r;
const finish = async (u, pos) => (await db.q(`SELECT public.daily_choice_finish($1, $2) AS r`, [u, pos]))[0].r;
const sessao = async (u) => (await db.q(`SELECT * FROM public.daily_choice_sessions WHERE user_id = $1 AND challenge_hour = $2`, [u, HORA]))[0];
const tentativas = async (u) => (await db.q(`SELECT count(*)::int AS n FROM public.daily_attempts WHERE user_id = $1`, [u]))[0].n;
const stats = async (u) => (await db.q(`SELECT current_streak, best_streak, last_played_hour, total_score FROM public.user_stats WHERE user_id = $1`, [u]))[0];
const conquistas = async (u) =>
  (await db.q(`SELECT achievement_code FROM public.user_achievements WHERE user_id = $1 ORDER BY 1`, [u])).map((r) => r.achievement_code);
const comoUsuario = async (u, sql) => {
  await db.exec("BEGIN");
  try {
    await db.exec(`SET LOCAL ROLE authenticated`);
    await db.q(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [u, JSON.stringify({ sub: u, role: "authenticated" })]);
    return await db.q(sql);
  } finally {
    await db.exec("ROLLBACK");
  }
};
const negado = async (role, sql) => {
  await db.exec("BEGIN");
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    await db.q(sql);
    return false;
  } catch (e) {
    return /permission denied|42501/i.test(String(e?.message ?? e) + (e?.code ?? ""));
  } finally {
    await db.exec("ROLLBACK");
  }
};

const W1 = await novaPalavra(1);
const W2 = await novaPalavra(2);
const W3 = await novaPalavra(3);
const NAO_PUBLICADA = await novaPalavra(4, { status: "draft" });
const RASCUNHO = await novaPalavra(5, { conjunto: "rascunho" });
const SEM_CONJUNTO = await novaPalavra(6, { conjunto: null });
const MUDOU = await novaPalavra(7);
await db.q(`UPDATE public.words SET meaning = meaning || ' (editada)' WHERE id = $1`, [MUDOU.id]);
const APROVADAS = new Set([W1.id, W2.id, W3.id]);

try {
  // -------------------------------------------------------------------------
  await t("0/16. migration inerte: daily_mode = 'juiz'; histórico e pontuação V2 intocados", async () => {
    if (!modePg) {
      eq((await db.q(`SELECT value FROM public.app_config WHERE key = 'daily_mode'`))[0].value, "juiz");
      const md5Depois = (await db.q(`SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'submit_daily_attempt_scored'`))[0].m;
      eq(md5Depois, md5Antes, "md5 da pontuação mudou com a migration");
      const depois = await db.q(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS m FROM (
          SELECT user_id, current_streak, best_streak, last_played_hour, total_score FROM public.user_stats) t`);
      eq(depois, estadoAntes, "user_stats mudou com a migration");
      eq((await db.q(`SELECT mode, score FROM public.daily_attempts WHERE guess = 'palpite'`))[0], { mode: "juiz", score: 77 });
    } else {
      // banco do CI: a pontuação do juiz é a MESMA da produção (md5 conferido em 08/11/2026)
      const m = (await db.q(`SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'submit_daily_attempt_scored'`))[0].m;
      ok(m.startsWith("e41b8c87"), `md5 ${m.slice(0, 8)} ≠ e41b8c87`);
    }
    eq((await db.q(`SELECT public.daily_mode() AS m`))[0].m, modoAntes ?? "juiz");
  });

  await t("5. tabelas e funções do D1 fechadas para anon/authenticated (permission denied)", async () => {
    for (const tab of ["daily_choice_sets", "daily_choice_sessions"])
      for (const r of ["anon", "authenticated"]) {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
          eq((await db.q(`SELECT has_table_privilege($1, $2, $3) AS p`, [r, `public.${tab}`, p]))[0].p, false, `${r} ${p} ${tab}`);
        ok(await negado(r, `SELECT * FROM public.${tab}`), `${r} conseguiu SELECT em ${tab}`);
        const upd = tab === "daily_choice_sets" ? "status = 'aprovado'" : "finished_at = now()";
        ok(await negado(r, `UPDATE public.${tab} SET ${upd}`), `${r} conseguiu UPDATE em ${tab}`);
      }
    ok(await negado("authenticated", `INSERT INTO public.daily_choice_sets (word_id, distractors, truth_snapshot) VALUES ('${W1.id}', ARRAY['a','b','c'], 'x')`), "INSERT em sets");
    const fns = ["daily_mode()", "daily_choice_start(uuid)", "daily_choice_finish(uuid,integer)", "daily_record_participation(uuid,timestamptz,integer)",
      "daily_choice_new_perm()", "daily_choice_fmt(text)", "daily_choice_admin_list(text,integer,integer)", "daily_choice_admin_get(uuid[])", "daily_choice_admin_pool(integer)",
      "daily_choice_admin_add_drafts(jsonb)", "daily_choice_admin_edit(uuid,text[],jsonb)", "daily_choice_admin_review(uuid[],text,uuid)", "daily_choice_cleanup()"];
    for (const f of fns)
      for (const r of ["anon", "authenticated"])
        eq((await db.q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS p`, [r, `public.${f}`]))[0].p, false, `${r} executa ${f}`);
    for (const f of ["daily_choice_start(uuid)", "daily_choice_finish(uuid,integer)", "daily_choice_admin_review(uuid[],text,uuid)"])
      eq((await db.q(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS p`, [`public.${f}`]))[0].p, true, `service_role ${f}`);
    // o placar recriado mantém as permissões de antes: authenticated sim, anon não
    eq((await db.q(`SELECT has_function_privilege('authenticated', 'public.get_daily_leaderboard(integer,text)', 'EXECUTE') AS p`))[0].p, true);
    eq((await db.q(`SELECT has_function_privilege('anon', 'public.get_daily_leaderboard(integer,text)', 'EXECUTE') AS p`))[0].p, false);
  });

  await t("21. daily_mode = 'juiz': o início do modo escolha só devolve o modo; nada é criado", async () => {
    await setModo("juiz");
    const u = await novoUsuario();
    eq(await start(u), { status: "mode", mode: "juiz" });
    eq(await sessao(u), undefined);
    await setModo("pausa");
    eq(await start(u), { status: "mode", mode: "pausa" });
    await setModo("valor-invalido");
    eq((await db.q(`SELECT public.daily_mode() AS m`))[0].m, "juiz", "inválido virou outra coisa");
  });

  await setModo("escolha");

  await t("18. modo escolha sorteia SÓ conjunto aprovado + publicado + definição igual à revisada", async () => {
    const vistos = new Set();
    for (let i = 0; i < 40; i++) {
      await forcarDesafio(null);
      await db.q(`SELECT public.get_or_create_daily_challenge()`);
      const [{ word_id }] = await db.q(`SELECT word_id FROM public.daily_challenges WHERE challenge_hour = $1`, [HORA]);
      vistos.add(word_id);
      for (const x of [NAO_PUBLICADA.id, RASCUNHO.id, SEM_CONJUNTO.id, MUDOU.id]) ok(word_id !== x, "sorteou palavra proibida");
      if (modePg) {
        // no banco do CI pode haver outros aprovados de outras suítes: todo sorteado TEM de ser aprovado jogável
        const [{ okSet }] = await db.q(
          `SELECT EXISTS (SELECT 1 FROM public.daily_choice_sets s JOIN public.words w ON w.id = s.word_id
             WHERE s.word_id = $1 AND s.status = 'aprovado' AND w.status = 'published' AND w.meaning = s.truth_snapshot) AS "okSet"`,
          [word_id],
        );
        ok(okSet, "sorteou palavra sem conjunto aprovado jogável");
      } else ok(APROVADAS.has(word_id), "sorteou fora dos aprovados");
    }
    if (!modePg) eq(vistos.size, 3, "não variou entre os aprovados");
  });

  await t("18. sem repetir: o menos usado (ou nunca usado) vem primeiro", async () => {
    if (modePg && (await db.q(`SELECT count(*)::int AS n FROM public.daily_choice_sets WHERE status = 'aprovado' AND NOT (word_id = ANY($1::uuid[]))`, [palavras]))[0].n > 0)
      return console.log("      (pulado no CI: há outros aprovados no banco)");
    await db.q(`INSERT INTO public.daily_challenges (challenge_date, challenge_hour, word_id) VALUES
      (($1::timestamptz - interval '3000 hours')::date, $1::timestamptz - interval '3000 hours', $2),
      (($1::timestamptz - interval '2999 hours')::date, $1::timestamptz - interval '2999 hours', $3)`, [HORA, W1.id, W2.id]);
    await forcarDesafio(null);
    await db.q(`SELECT public.get_or_create_daily_challenge()`);
    eq((await db.q(`SELECT word_id FROM public.daily_challenges WHERE challenge_hour = $1`, [HORA]))[0].word_id, W3.id);
  });

  await t("18. palavra da hora sem conjunto aprovado (criada no modo juiz) = pausa, NADA gasto", async () => {
    for (const w of [SEM_CONJUNTO, RASCUNHO, NAO_PUBLICADA, MUDOU]) {
      await forcarDesafio(w.id);
      const u = await novoUsuario();
      eq(await start(u), { status: "sem_estoque" });
      eq(await sessao(u), undefined, "criou sessão");
      eq(await tentativas(u), 0, "gastou tentativa");
      eq((await finish(u, 0)).status, "no_session");
      eq(await tentativas(u), 0);
    }
    await forcarDesafio(W1.id);
  });

  await t("4/6. início: 4 alternativas sem a correta nem ids; mesma ordem e mesmo relógio ao reabrir", async () => {
    const u = await novoUsuario();
    const a = await start(u);
    eq(a.status, "ok");
    eq(Object.keys(a).sort(), ["category", "elapsed_s", "options", "status", "word"]);
    eq(a.options.map((o) => Object.keys(o).sort().join()), ["pos,text", "pos,text", "pos,text", "pos,text"]);
    eq(a.options.map((o) => o.pos), [0, 1, 2, 3]);
    ok(a.options.some((o) => o.text === W1.meaning), "a verdadeira não está entre as alternativas");
    const s1 = await sessao(u);
    const b = await start(u);
    eq(b.options, a.options, "ordem mudou ao reabrir");
    eq((await sessao(u)).issued_at, s1.issued_at, "relógio reiniciou ao reabrir");
    ok(!JSON.stringify(a).match(/correct|word_id|[0-9a-f]{8}-[0-9a-f]{4}-/), "vazou correta/id");
  });

  await t("4. forma uniforme: as 4 alternativas não se denunciam por maiúscula ou pontuação final", async () => {
    const F = await novaPalavra(10, { meaning: `espinho; recife à flor da água ${tag}.` });
    await db.q(`UPDATE public.daily_choice_sets SET distractors = ARRAY['Ave pequena do litoral.', 'dança popular;', '  Tecido grosso  '] WHERE word_id = $1`, [F.id]);
    await forcarDesafio(F.id);
    const u = await novoUsuario();
    const a = await start(u);
    eq(a.status, "ok");
    for (const o of a.options) {
      ok(/^[A-ZÀ-Ý]/.test(o.text), `minúscula no início: ${o.text}`);
      ok(!/[s.;,:]$/.test(o.text), `pontuação no fim: ${o.text}`);
    }
    ok(a.options.some((o) => o.text === `Espinho; recife à flor da água ${tag}`), "a correta não foi só reformatada");
    const s = await sessao(u);
    const r2 = await finish(u, s.correct_pos);
    eq(r2.result.truth, `Espinho; recife à flor da água ${tag}`);
    await forcarDesafio(W1.id);
  });

  await t("6. entre 200 jogadores a correta cai em cada posição de 15% a 35% das vezes", async () => {
    const cont = [0, 0, 0, 0];
    for (let i = 0; i < 200; i++) {
      const u = await novoUsuario();
      eq((await start(u)).status, "ok");
      cont[(await sessao(u)).correct_pos]++;
    }
    for (const c of cont) ok(c >= 30 && c <= 70, `distribuição ${cont.join("/")}`);
    console.log(`      posições da correta: ${cont.join(" / ")}`);
  });

  await t("8/17. tempo do SERVIDOR (± 1 s) e fórmula D-c; finish nem recebe tempo do cliente", async () => {
    const [{ args: a }] = await db.q(`SELECT pg_get_function_identity_arguments('public.daily_choice_finish(uuid,integer)'::regprocedure) AS args`);
    eq(a, "p_user_id uuid, p_pos integer");
    for (const segs of [0, 30, 79, 80, 200, 900]) {
      const u = await novoUsuario();
      await start(u);
      await db.q(`UPDATE public.daily_choice_sessions SET issued_at = now() - make_interval(secs => $2) WHERE user_id = $1`, [u, segs]);
      const s = await sessao(u);
      const r = await finish(u, s.correct_pos);
      eq(r.status, "recorded");
      const esperado = Math.min(600, segs);
      ok(Math.abs(r.result.time_seconds - esperado) <= 1, `t=${r.result.time_seconds} esperado ${esperado}`);
      eq(r.result.score, pontos(r.result.time_seconds), `pontos t=${r.result.time_seconds}`);
      eq(r.result.is_correct, true);
      const [linha] = await db.q(`SELECT mode, similarity, score, time_seconds, is_correct FROM public.daily_attempts WHERE user_id = $1`, [u]);
      eq(linha, { mode: "escolha", similarity: 0, score: r.result.score, time_seconds: r.result.time_seconds, is_correct: true });
    }
  });

  await t("11/17. erro = 0 pontos e CONTA como participação (sequência +1)", async () => {
    const u = await novoUsuario();
    await definirStats(u, { streak: 4, best: 4, horasAtras: 1, total: 100 });
    await start(u);
    const s = await sessao(u);
    const r = await finish(u, (s.correct_pos + 1) % 4);
    eq([r.status, r.result.is_correct, r.result.score, r.result.current_streak], ["recorded", false, 0, 5]);
    eq(r.result.chosen, s.options[(s.correct_pos + 1) % 4]);
    eq(r.result.truth, s.options[s.correct_pos]);
    const st = await stats(u);
    eq([st.current_streak, st.best_streak, st.total_score], [5, 5, 100]);
  });

  await t("7. 2º envio e envio sem início = exatamente 1 / 0 linha", async () => {
    const u = await novoUsuario();
    eq((await finish(u, 0)).status, "no_session");
    eq(await tentativas(u), 0);
    await start(u);
    eq((await finish(u, 0)).status, "recorded");
    eq((await finish(u, 1)).status, "already_played");
    eq((await finish(u, 0)).status, "already_played");
    eq(await start(u), { status: "already_played" });
    eq(await tentativas(u), 1);
  });

  await t("7. envios SIMULTÂNEOS (conexões independentes no CI) = exatamente 1 linha", async () => {
    const u = await novoUsuario();
    await start(u);
    if (modePg) {
      const cs = await Promise.all(Array.from({ length: 6 }, () => db.conn()));
      try {
        const rs = await Promise.all(cs.map((c, i) => c.query(`SELECT public.daily_choice_finish($1, $2) AS r`, [u, i % 4]).then((x) => x.rows[0].r)));
        eq(rs.filter((r) => r.status === "recorded").length, 1, JSON.stringify(rs.map((r) => r.status)));
        eq(rs.filter((r) => r.status === "already_played").length, 5);
      } finally {
        await Promise.all(cs.map((c) => c.end()));
      }
    } else {
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => finish(u, i % 4)));
      eq(rs.filter((r) => r.status === "recorded").length, 1);
    }
    eq(await tentativas(u), 1);
  });

  await t("7. uma tentativa por hora NOS DOIS MODOS: juiz × escolha na mesma hora (inclusive simultâneo)", async () => {
    // escolha depois de juiz
    const a = await novoUsuario();
    await db.q(`SELECT public.submit_daily_attempt_scored($1, 'palpite', 10, 90)`, [a]);
    eq(await start(a), { status: "already_played" });
    // juiz depois de escolha (fluxo antigo e V2)
    const b = await novoUsuario();
    await start(b);
    eq((await finish(b, 0)).status, "recorded");
    eq((await db.q(`SELECT public.submit_daily_attempt_scored($1, 'x', 5, 95) AS r`, [b]))[0].r.already_played, true);
    await db.q(`INSERT INTO public.app_config (key, value) VALUES ('daily_guard_mode', 'aplicar') ON CONFLICT (key) DO UPDATE SET value = 'aplicar'`);
    eq((await db.q(`SELECT public.daily_claim($1, $2) AS r`, [b, HORA]))[0].r.status, "already_played");
    await db.q(`UPDATE public.app_config SET value = 'observar' WHERE key = 'daily_guard_mode'`);
    eq(await tentativas(b), 1);
    // corrida: o juiz (V2: reserva + daily_finish_ok) e o modo escolha ao mesmo tempo
    const c = await novoUsuario();
    await start(c);
    const claim = (await db.q(`SELECT public.daily_claim($1, $2) AS r`, [c, HORA]))[0].r;
    eq(claim.status, "claimed");
    if (modePg) {
      const cs = await Promise.all(Array.from({ length: 4 }, () => db.conn()));
      try {
        await Promise.all([
          cs[0].query(`SELECT public.daily_finish_ok($1, $2, $3, 'palpite', 7, 92)`, [c, HORA, claim.claim_id]),
          ...cs.slice(1).map((x, i) => x.query(`SELECT public.daily_choice_finish($1, $2)`, [c, i])),
        ]);
      } finally {
        await Promise.all(cs.map((x) => x.end()));
      }
    } else {
      await db.q(`SELECT public.daily_finish_ok($1, $2, $3, 'palpite', 7, 92)`, [c, HORA, claim.claim_id]);
      await finish(c, 0);
    }
    eq(await tentativas(c), 1, "duas tentativas na mesma hora");
  });

  await t("9. trocar o modo no meio da hora: o envio antigo devolve 'mode_changed' SEM gastar", async () => {
    const u = await novoUsuario();
    await start(u);
    await setModo("juiz");
    eq(await finish(u, 0), { status: "mode_changed" });
    eq(await tentativas(u), 0);
    await setModo("pausa");
    eq(await finish(u, 0), { status: "mode_changed" });
    eq(await tentativas(u), 0);
    await setModo("escolha");
    eq((await finish(u, 0)).status, "recorded", "a sessão aberta antes da troca segue válida ao voltar");
  });

  await t("hora virou entre o início e o fim: 'hour_changed', nada gasto", async () => {
    const u = await novoUsuario();
    await db.q(`INSERT INTO public.daily_choice_sessions (user_id, challenge_hour, word_id, options, correct_pos)
                VALUES ($1, $2::timestamptz - interval '1 hour', $3, ARRAY['a','b','c','d'], 0)`, [u, HORA, W1.id]);
    eq(await finish(u, 0), { status: "hour_changed" });
    eq(await tentativas(u), 0);
  });

  await t("gatilho real: usuário novo já tem user_stats zerado; 1ª participação = sequência 1 nos DOIS modos, sem erro", async () => {
    const [e, j] = [await novoUsuario(), await novoUsuario()];
    for (const u of [e, j]) eq(await stats(u), { current_streak: 0, best_streak: 0, last_played_hour: null, total_score: 0 }, "gatilho não criou a linha zerada");
    await start(e);
    const re = await finish(e, (await sessao(e)).correct_pos);
    const rj = (await db.q(`SELECT public.submit_daily_attempt_scored($1, 'x', 10, 90) AS r`, [j]))[0].r;
    eq([re.result.current_streak, rj.current_streak], [1, 1]);
    eq((await stats(e)).total_score, re.result.score);
    eq((await stats(j)).total_score, rj.score);
    eq([await conquistas(e), await conquistas(j)], [["first_daily"], ["first_daily"]]);
  });

  await t("10/13. sequência e conquistas com MISTURA de modos (juiz → escolha → juiz)", async () => {
    // juiz na hora anterior → escolha agora: +1, streak_3
    const a = await novoUsuario();
    await db.q(`INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, score, mode) VALUES ($1, ($2::timestamptz - interval '1 hour')::date, $2::timestamptz - interval '1 hour', 'p', 0, 'juiz')`, [a, HORA]);
    await definirStats(a, { streak: 2, best: 2, horasAtras: 1 });
    await db.q(`INSERT INTO public.user_achievements (user_id, achievement_code) VALUES ($1, 'first_daily')`, [a]);
    await start(a);
    const ra = await finish(a, (await sessao(a)).correct_pos);
    eq([ra.result.current_streak, ra.result.unlocked], [3, ["streak_3"]]);
    // escolha na hora anterior → juiz agora: +1
    const b = await novoUsuario();
    await db.q(`INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, score, mode) VALUES ($1, ($2::timestamptz - interval '1 hour')::date, $2::timestamptz - interval '1 hour', 'p', 10, 'escolha')`, [b, HORA]);
    await definirStats(b, { streak: 6, best: 6, horasAtras: 1 });
    const rb = (await db.q(`SELECT public.submit_daily_attempt_scored($1, 'x', 10, 95) AS r`, [b]))[0].r;
    eq([rb.current_streak, rb.unlocked.sort()], [7, ["first_daily", "streak_3", "streak_7"]]);
    // hora pulada → volta a 1
    const c = await novoUsuario();
    await definirStats(c, { streak: 9, best: 9, horasAtras: 3 });
    await start(c);
    const rc = await finish(c, 0);
    eq([rc.result.current_streak, (await stats(c)).best_streak], [1, 9]);
  });

  await t("10/11/13. PARIDADE: daily_record_participation = bloco de submit_daily_attempt_scored (36 estados)", async () => {
    const ultimas = [null, "0", "1", "2"]; // horas atrás
    const seqs = [0, 1, 2, 6, 29];
    let n = 0;
    for (const h of ultimas)
      for (const s of seqs)
        for (const comFirst of [false, true]) {
          if (n++ >= 36) break;
          const [a, b] = [await novoUsuario(), await novoUsuario()];
          for (const u of [a, b]) {
            await definirStats(u, { streak: s, best: s + 1, horasAtras: h === null ? null : Number(h), total: 50 });
            if (comFirst) await db.q(`INSERT INTO public.user_achievements (user_id, achievement_code) VALUES ($1, 'first_daily')`, [u]);
          }
          const juiz = (await db.q(`SELECT public.submit_daily_attempt_scored($1, 'x', 10, 90) AS r`, [a]))[0].r;
          const part = (await db.q(`SELECT public.daily_record_participation($1, $2, $3) AS r`, [b, HORA, juiz.score]))[0].r;
          eq([part.current_streak, [...part.unlocked].sort()], [juiz.current_streak, [...juiz.unlocked].sort()], `estado h=${h} s=${s} first=${comFirst}`);
          const [sa, sb] = [await stats(a), await stats(b)];
          eq(sb, sa, `user_stats h=${h} s=${s}`);
          eq(await conquistas(b), await conquistas(a));
        }
  });

  await t("12/14. ligar/desligar o D1 não recalcula nada: user_stats e conquistas idênticos", async () => {
    const snap = async () =>
      (await db.q(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS m FROM (
          SELECT s.user_id, s.current_streak, s.best_streak, s.last_played_hour, s.total_score,
                 (SELECT string_agg(achievement_code, ',' ORDER BY achievement_code) FROM public.user_achievements a WHERE a.user_id = s.user_id) AS ach
            FROM public.user_stats s) t`))[0].m;
    const antes = await snap();
    for (const m of ["juiz", "escolha", "pausa", "juiz", "escolha"]) {
      await setModo(m);
      await db.q(`SELECT public.get_or_create_daily_challenge()`);
      await db.q(`SELECT * FROM public.get_daily_leaderboard(20)`);
    }
    eq(await snap(), antes);
  });

  await t("14. conquista não é concedida em dobro ao alternar o modo", async () => {
    const u = await novoUsuario();
    await start(u);
    const r = await finish(u, 0);
    eq(r.result.unlocked, ["first_daily"]);
    const again = (await db.q(`SELECT public.daily_record_participation($1, $2, 0) AS r`, [u, HORA]))[0].r;
    eq(again.unlocked, []);
    eq(await conquistas(u), ["first_daily"]);
  });

  await t("15. placar do Diário NÃO mistura os modos (coluna mode; padrão = modo vigente)", async () => {
    const [j, e] = [await novoUsuario(), await novoUsuario()];
    await db.q(`INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, score, time_seconds, is_correct, mode)
                VALUES ($1, $3::timestamptz::date, $3::timestamptz, 'j', 999, 1, true, 'juiz'), ($2, $3::timestamptz::date, $3::timestamptz, 'e', 998, 1, true, 'escolha')`, [j, e, HORA]);
    const modos = async (sql) => new Set((await db.q(sql)).map((r) => r.mode));
    eq([...(await modos(`SELECT * FROM public.get_daily_leaderboard(100, 'escolha')`))], ["escolha"]);
    eq([...(await modos(`SELECT * FROM public.get_daily_leaderboard(100, 'juiz')`))], ["juiz"]);
    await setModo("escolha");
    eq([...(await modos(`SELECT * FROM public.get_daily_leaderboard(100)`))], ["escolha"], "padrão no modo escolha");
    await setModo("juiz");
    eq([...(await modos(`SELECT * FROM public.get_daily_leaderboard(100)`))], ["juiz"], "padrão no modo juiz");
    await setModo("pausa");
    eq((await modos(`SELECT * FROM public.get_daily_leaderboard(100)`)).size, 2, "pausa mostra tudo");
    await setModo("escolha");
    // cliente antigo (só p_limit, como usuário autenticado) continua funcionando
    const old = await comoUsuario(j, `SELECT * FROM public.get_daily_leaderboard(20)`);
    ok(Array.isArray(old) && old.every((r) => "mode" in r), "placar antigo quebrou");
  });

  await t("16. ranking global: soma UMA vez, sem fator extra (total_score += pontos do acerto)", async () => {
    const u = await novoUsuario();
    await definirStats(u, { total: 1000 });
    await start(u);
    await db.q(`UPDATE public.daily_choice_sessions SET issued_at = now() - interval '10 seconds' WHERE user_id = $1`, [u]);
    const r = await finish(u, (await sessao(u)).correct_pos);
    eq((await stats(u)).total_score, 1000 + r.result.score);
    eq(r.result.score, pontos(r.result.time_seconds));
    await finish(u, 0); // 2º envio não soma de novo
    eq((await stats(u)).total_score, 1000 + r.result.score);
  });

  await t("revisão do jogador (get_my_daily_review): modo da tentativa e modo vigente; nada da escolha antes de jogar", async () => {
    const u = await novoUsuario();
    const antes = (await comoUsuario(u, `SELECT public.get_my_daily_review() AS r`))[0].r;
    eq(antes, { played: false, daily_mode: "escolha" });
    await start(u);
    const s = await sessao(u);
    await finish(u, s.correct_pos);
    const depois = (await comoUsuario(u, `SELECT public.get_my_daily_review() AS r`))[0].r;
    eq([depois.played, depois.attempt.mode, depois.attempt.guess, depois.truth, depois.daily_mode], [true, "escolha", s.options[s.correct_pos], W1.meaning, "escolha"]);
  });

  await t("revisão editorial: rascunho → aprovado só com validador OK, publicada e definição igual", async () => {
    const reviewer = randomUUID();
    const X = await novaPalavra(8, { conjunto: "rascunho" });
    const Y = await novaPalavra(9, { conjunto: "rascunho" });
    await db.q(`UPDATE public.daily_choice_sets SET validacao = '{"ok":false}' WHERE word_id = $1`, [Y.id]);
    const r = (await db.q(`SELECT public.daily_choice_admin_review($1::uuid[], 'aprovado', $2) AS r`, [[X.id, Y.id, MUDOU.id], reviewer]))[0].r;
    eq(r, { updated: 1, skipped: 2 });
    eq((await db.q(`SELECT status FROM public.daily_choice_sets WHERE word_id = $1`, [X.id]))[0].status, "aprovado");
    // edição volta a rascunho e atualiza a verdade revisada
    const ed = (await db.q(`SELECT public.daily_choice_admin_edit($1, ARRAY['x','y','z'], '{"ok":true}') AS r`, [MUDOU.id]))[0].r;
    eq(ed, { updated: 1 });
    eq((await db.q(`SELECT status, truth_snapshot = (SELECT meaning FROM public.words WHERE id = $1) AS t FROM public.daily_choice_sets WHERE word_id = $1`, [MUDOU.id]))[0], { status: "rascunho", t: true });
    // rascunhos novos nunca nascem aprovados
    const n = (await db.q(`SELECT public.daily_choice_admin_add_drafts($1::jsonb) AS n`, [JSON.stringify([{ word_id: SEM_CONJUNTO.id, distractors: ["a", "b", "c"], validacao: { ok: true } }])]))[0].n;
    eq(n, 1);
    eq((await db.q(`SELECT status FROM public.daily_choice_sets WHERE word_id = $1`, [SEM_CONJUNTO.id]))[0].status, "rascunho");
    const lst = (await db.q(`SELECT public.daily_choice_admin_list('rascunho', 50, 0) AS r`))[0].r;
    ok(lst.counts.rascunho >= 3 && Array.isArray(lst.items), "lista");
    const pool = (await db.q(`SELECT public.daily_choice_admin_pool(10) AS r`))[0].r;
    ok(pool.pool.every((p) => p.id !== NAO_PUBLICADA.id), "fonte de distratores com palavra não publicada");
    ok(pool.targets.every((p) => p.id !== SEM_CONJUNTO.id), "alvo que já tem conjunto");
    let erro = false;
    try {
      await db.q(`SELECT public.daily_choice_admin_review(ARRAY[]::uuid[], 'aprovado', $1)`, [reviewer]);
    } catch {
      erro = true;
    }
    ok(erro, "aceitou lote vazio");
  });

  if (!modePg) {
    await t("rollback total: aplica limpo; histórico e pontuação intactos; Diário antigo funciona", async () => {
      await setModo("juiz");
      const totalAntes = (await db.q(`SELECT sum(total_score)::int AS s FROM public.user_stats`))[0].s;
      const nAntes = (await db.q(`SELECT count(*)::int AS n FROM public.daily_attempts`))[0].n;
      await db.exec(D1_ROLLBACK);
      eq((await db.q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'daily_choice%' OR proname IN ('daily_mode', 'daily_record_participation')`))[0].n, 0);
      eq((await db.q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'daily_attempts' AND column_name = 'mode'`))[0].n, 0);
      eq((await db.q(`SELECT sum(total_score)::int AS s FROM public.user_stats`))[0].s, totalAntes);
      eq((await db.q(`SELECT count(*)::int AS n FROM public.daily_attempts`))[0].n, nAntes);
      eq((await db.q(`SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'submit_daily_attempt_scored'`))[0].m, md5Antes);
      await forcarDesafio(null);
      ok((await db.q(`SELECT public.get_or_create_daily_challenge() AS r`))[0].r.word.id, "sorteio antigo quebrou");
      const u = await novoUsuario();
      eq((await db.q(`SELECT public.submit_daily_attempt_scored($1, 'x', 10, 90) AS r`, [u]))[0].r.is_correct, true);
      await db.exec(D1); // e a migration reaplica limpa por cima (idempotente)
      eq((await db.q(`SELECT public.daily_mode() AS m`))[0].m, "juiz");
    });
  }
} finally {
  // limpeza (no CI o banco segue para as outras suítes)
  if (modePg) {
    if (modoAntes === null) await db.q(`DELETE FROM public.app_config WHERE key = 'daily_mode'`);
    else await setModo(modoAntes);
    await db.q(`UPDATE public.app_config SET value = 'observar' WHERE key = 'daily_guard_mode'`).catch(() => {});
    await db.q(`DELETE FROM public.daily_attempts WHERE user_id = ANY($1::uuid[])`, [usuarios]);
    await db.q(`DELETE FROM public.daily_eval_claims WHERE user_id = ANY($1::uuid[])`, [usuarios]).catch(() => {});
    await db.q(`DELETE FROM public.user_achievements WHERE user_id = ANY($1::uuid[])`, [usuarios]);
    await db.q(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [usuarios]);
    await db.q(`DELETE FROM public.daily_challenges WHERE word_id = ANY($1::uuid[]) OR challenge_hour = $2`, [palavras, HORA]);
    if (desafioAntes)
      await db.q(`INSERT INTO public.daily_challenges (id, challenge_date, challenge_hour, word_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [desafioAntes.id, desafioAntes.challenge_date, desafioAntes.challenge_hour, desafioAntes.word_id]);
    await db.q(`DELETE FROM public.words WHERE id = ANY($1::uuid[])`, [palavras]);
  }
  await db.close();
}

console.log(`\n${pass} ok, ${fail} falha(s)`);
if (fail) {
  console.log("FALHAS:\n - " + falhas.join("\n - "));
  process.exit(1);
}
console.log("DIÁRIO D1 (modo escolha) OK");
