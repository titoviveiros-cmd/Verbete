// V2 — Desafio Diário: testes SQL da reserva atômica (migration 20261105150000_daily_guard_v2.sql).
//
// Dois modos:
//   node scripts/test-daily-guard.mjs --pglite <pasta do @electric-sql/pglite>
//       Offline, sem rede: Postgres embutido (uma conexão). Monta um esquema MÍNIMO
//       e usa a função de pontuação REAL (copiada da migration que a define).
//       Limite: uma conexão só — corrida entre PROCESSOS não é reproduzível aqui.
//   DB_URL=postgres://…127.0.0.1… node scripts/test-daily-guard.mjs        (padrão; CI)
//       Postgres REAL já migrado (Supabase local do runner, via run-integration.mjs):
//       roda também as corridas com VÁRIAS conexões independentes.
//       Sem DB_URL = FALHA (nunca "passa" por falta de banco). Só aceita banco LOCAL.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = readFileSync(join(ROOT, "supabase/migrations/20261105150000_daily_guard_v2.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollback/daily_guard_v2.sql"), "utf8");
const SCORING_SRC = readFileSync(join(ROOT, "supabase/migrations/20260608161016_4a498957-8605-4dfc-a9cd-494245ccb841.sql"), "utf8");

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

let db; // { q(sql, params) → rows, exec(sql), close(), conn() → nova conexão (só pg) }
if (modePg) {
  const { default: pg } = await import("pg");
  const mk = async () => {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    return c;
  };
  const main = await mk();
  db = {
    q: async (s, p = []) => (await main.query(s, p)).rows,
    exec: (s) => main.query(s),
    close: () => main.end(),
    conn: mk,
  };
} else {
  if (!pglitePath) throw new Error("uso: --pglite <pasta do @electric-sql/pglite> | --pg");
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
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg ?? "diferente"}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
};
const ok = (v, msg) => {
  if (!v) throw new Error(msg ?? "falso");
};

// ---------------------------------------------------------------------------
// Esquema mínimo (só PGlite). No --pg o banco já tem tudo.
// ---------------------------------------------------------------------------
if (!modePg) {
  const scoring = SCORING_SRC.slice(
    SCORING_SRC.indexOf("CREATE OR REPLACE FUNCTION public.submit_daily_attempt_scored"),
    SCORING_SRC.indexOf("$function$;", SCORING_SRC.indexOf("CREATE OR REPLACE FUNCTION public.submit_daily_attempt_scored")) + "$function$;".length,
  );
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA extensions;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, is_anonymous boolean NOT NULL DEFAULT false);
    CREATE TABLE public.app_config (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION public.get_app_config(p_key text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path TO 'public' AS $$ SELECT value FROM public.app_config WHERE key = p_key; $$;
    CREATE TABLE public.ops_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
      kind text NOT NULL, build text, session_key text, room_hash text, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE public.words (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), word text, meaning text);
    CREATE TABLE public.daily_challenges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), challenge_date date,
      challenge_hour timestamptz NOT NULL UNIQUE, word_id uuid NOT NULL);
    CREATE TABLE public.daily_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      challenge_date date, challenge_hour timestamptz NOT NULL, guess text NOT NULL, is_correct boolean NOT NULL DEFAULT false,
      score integer NOT NULL DEFAULT 0, time_seconds integer NOT NULL DEFAULT 0, similarity integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT daily_attempts_user_challenge_hour_key UNIQUE (user_id, challenge_hour));
    CREATE TABLE public.user_stats (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      current_streak integer NOT NULL DEFAULT 0, best_streak integer NOT NULL DEFAULT 0, last_played_date date,
      last_played_hour timestamptz, total_score integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.user_achievements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      achievement_code text NOT NULL, unlocked_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, achievement_code));
    INSERT INTO public.words (id, word, meaning) VALUES ('11111111-1111-1111-1111-111111111111', 'palavra-teste', 'definição-teste');
    CREATE FUNCTION public.get_or_create_daily_challenge() RETURNS void LANGUAGE sql AS $$
      INSERT INTO public.daily_challenges (challenge_date, challenge_hour, word_id)
      VALUES (date_trunc('hour', now())::date, date_trunc('hour', now()), '11111111-1111-1111-1111-111111111111')
      ON CONFLICT (challenge_hour) DO NOTHING; $$;
    ${scoring}
  `);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const HORA = (await db.q(`SELECT date_trunc('hour', now()) AS h`))[0].h;
const HORA_ANT = (await db.q(`SELECT date_trunc('hour', now()) - interval '1 hour' AS h`))[0].h;
const criados = [];
const novoUsuario = async (anon = false) => {
  const id = randomUUID();
  criados.push(id);
  await db.q(`INSERT INTO auth.users (id, is_anonymous) VALUES ($1, $2)`, [id, anon]);
  return id;
};
const setCfg = (k, v) =>
  db.q(`INSERT INTO public.app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
const modo = (m) => setCfg("daily_guard_mode", m);
const claim = async (u, h = HORA, origin = null) =>
  (await db.q(`SELECT public.daily_claim($1, $2, $3) AS r`, [u, h, origin]))[0].r;
const finishOk = async (u, c, h = HORA, sim = 90, guess = "palpite de teste", secs = 10) =>
  (await db.q(`SELECT public.daily_finish_ok($1, $2, $3, $4, $5, $6) AS r`, [u, h, c, guess, secs, sim]))[0].r;
const finishFail = async (u, c, kind, h = HORA) =>
  (await db.q(`SELECT public.daily_finish_fail($1, $2, $3, $4) AS r`, [u, h, c, kind]))[0].r;
const linha = async (u, h = HORA) =>
  (await db.q(`SELECT * FROM public.daily_eval_claims WHERE user_id = $1 AND challenge_hour = $2`, [u, h]))[0];
const tentativas = async (u) => (await db.q(`SELECT count(*)::int AS n FROM public.daily_attempts WHERE user_id = $1`, [u]))[0].n;

console.log(`V2 daily_guard — modo ${modePg ? "pg (Postgres real)" : "PGlite (offline, 1 conexão)"}`);
await db.exec(MIG);
await setCfg("daily_guard_breaker_window_s", "86400"); // evita virada de janela no meio do teste

await t("0. migration: modo padrão = observar; permissões só service_role", async () => {
  eq((await db.q(`SELECT value FROM public.app_config WHERE key = 'daily_guard_mode'`))[0].value, "observar");
  for (const f of ["public.daily_claim(uuid,timestamptz,text)", "public.daily_finish_ok(uuid,timestamptz,uuid,text,integer,integer)", "public.daily_finish_fail(uuid,timestamptz,uuid,text)"]) {
    for (const r of ["anon", "authenticated"])
      eq((await db.q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS p`, [r, f]))[0].p, false, `${r} executa ${f}`);
    eq((await db.q(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS p`, [f]))[0].p, true, `service_role ${f}`);
  }
  for (const tab of ["daily_eval_claims", "ai_quota"])
    for (const r of ["anon", "authenticated"])
      eq((await db.q(`SELECT has_table_privilege($1, $2, 'SELECT') AS p`, [r, `public.${tab}`]))[0].p, false, `${r} lê ${tab}`);
});

await modo("aplicar");

await t("1. primeira tentativa legítima: reserva, grava pelo claim, resultado do submit_daily_attempt_scored", async () => {
  const u = await novoUsuario();
  const c = await claim(u);
  eq(c.status, "claimed");
  const f = await finishOk(u, c.claim_id);
  eq(f.status, "recorded");
  eq(f.result.already_played, false);
  eq(f.result.is_correct, true);
  eq((await linha(u)).state, "done");
  eq(await tentativas(u), 1);
});

await t("2/14. já jogou: 'already_played' com a tentativa (formato atual) e SEM contar avaliação", async () => {
  const u = await novoUsuario();
  const c = await claim(u);
  await finishOk(u, c.claim_id);
  const usadoAntes = (await db.q(`SELECT coalesce(sum(used),0)::int AS n FROM public.ai_quota WHERE key = $1`, [`daily_user:${u}`]))[0].n;
  const r = await claim(u);
  eq(r.status, "already_played");
  eq(r.already_played, true);
  eq(r.attempt.user_id, u);
  eq((await db.q(`SELECT coalesce(sum(used),0)::int AS n FROM public.ai_quota WHERE key = $1`, [`daily_user:${u}`]))[0].n, usadoAntes, "contou avaliação recusada");
});

await t("3. duplo clique: a 2ª reserva com a 1ª em andamento = 'in_progress' (sem IA)", async () => {
  const u = await novoUsuario();
  eq((await claim(u)).status, "claimed");
  eq((await claim(u)).status, "in_progress");
  eq((await claim(u)).status, "in_progress");
});

await t("4. pedidos 'simultâneos' (Promise.all; no PGlite são serializados): exatamente 1 reserva", async () => {
  const u = await novoUsuario();
  const rs = await Promise.all(Array.from({ length: 8 }, () => claim(u)));
  eq(rs.filter((r) => r.status === "claimed").length, 1);
  eq(rs.filter((r) => r.status === "in_progress").length, 7);
});

let pgSo = 0;
if (modePg) {
  const pgQ = async (c, sql, p) => (await c.query(sql, p)).rows[0].r;
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  await t("4c. TRAVA entre 2 conexões: enquanto A segura a transação, B ESPERA; depois recebe 'in_progress'", async () => {
    pgSo++;
    const u = await novoUsuario();
    const [A, B] = await Promise.all([db.conn(), db.conn()]);
    await A.query("BEGIN");
    const ra = await pgQ(A, `SELECT public.daily_claim($1, NULL, NULL) AS r`, [u]);
    eq(ra.status, "claimed");
    let rb = null;
    const pb = pgQ(B, `SELECT public.daily_claim($1, NULL, NULL) AS r`, [u]).then((r) => (rb = r));
    await espera(400);
    eq(rb, null, "B não esperou a trava de A");
    await A.query("COMMIT");
    await pb;
    eq(rb.status, "in_progress");
    await Promise.all([A.end(), B.end()]);
  });

  await t("4d. tentativa CONCLUÍDA + 6 conexões simultâneas: todas 'already_played' (nenhuma IA)", async () => {
    pgSo++;
    const u = await novoUsuario();
    const c0 = await claim(u);
    eq((await finishOk(u, c0.claim_id)).status, "recorded");
    const conns = await Promise.all(Array.from({ length: 6 }, () => db.conn()));
    const rs = await Promise.all(conns.map((c) => pgQ(c, `SELECT public.daily_claim($1, NULL, NULL) AS r`, [u])));
    eq(rs.map((r) => r.status), Array(6).fill("already_played"));
    eq(await tentativas(u), 1);
    await Promise.all(conns.map((c) => c.end()));
  });

  await t("4e. reserva vencida + finalizações CONCORRENTES (A atrasada, B vigente): só B grava, A 'stale'", async () => {
    pgSo++;
    const u = await novoUsuario();
    const a = await claim(u);
    await db.q(`UPDATE public.daily_eval_claims SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u]);
    const b = await claim(u);
    eq(b.status, "claimed");
    const [CA, CB] = await Promise.all([db.conn(), db.conn()]);
    const [fa, fb] = await Promise.all([
      pgQ(CA, `SELECT public.daily_finish_ok($1, $2, $3, 'p', 5, 90) AS r`, [u, HORA, a.claim_id]),
      pgQ(CB, `SELECT public.daily_finish_ok($1, $2, $3, 'p', 5, 90) AS r`, [u, HORA, b.claim_id]),
    ]);
    eq([fa.status, fb.status], ["stale", "recorded"]);
    eq(await tentativas(u), 1);
    await Promise.all([CA.end(), CB.end()]);
  });

  await t("4f. falha de transação numa conexão + reserva concorrente em outra: 'in_progress', depois liberação segura", async () => {
    pgSo++;
    const u = randomUUID();
    criados.push(u);
    const c = await claim(u);
    const [CA, CB] = await Promise.all([db.conn(), db.conn()]);
    let erro = null;
    try {
      await CA.query(`SELECT public.daily_finish_ok($1, $2, $3, 'p', 5, 90)`, [u, HORA, c.claim_id]);
    } catch (e) {
      erro = e;
    }
    ok(erro, "a gravação deveria falhar (sem auth.users)");
    eq(await tentativas(u), 0);
    eq((await pgQ(CB, `SELECT public.daily_claim($1, NULL, NULL) AS r`, [u])).status, "in_progress");
    eq((await pgQ(CA, `SELECT public.daily_finish_fail($1, $2, $3, 'persist') AS r`, [u, HORA, c.claim_id])).status, "released");
    eq((await pgQ(CB, `SELECT public.daily_claim($1, NULL, NULL) AS r`, [u])).status, "claimed");
    await Promise.all([CA.end(), CB.end()]);
  });

  await t("4g. modo OBSERVAR com 6 conexões simultâneas: 1 reserva + 5 'pass_no_claim' (fluxo antigo, nada bloqueado)", async () => {
    pgSo++;
    await modo("observar");
    const u = await novoUsuario();
    const conns = await Promise.all(Array.from({ length: 6 }, () => db.conn()));
    const rs = await Promise.all(conns.map((c) => pgQ(c, `SELECT public.daily_claim($1, NULL, NULL) AS r`, [u])));
    eq(rs.filter((r) => r.status === "claimed").length, 1);
    eq(rs.filter((r) => r.status === "pass_no_claim" && r.would_block === "in_progress").length, 5);
    await Promise.all(conns.map((c) => c.end()));
    await modo("aplicar");
  });

  await t("4b. CORRIDA REAL entre 10 conexões: exatamente 1 reserva e 1 gravação", async () => {
    pgSo++;
    const u = await novoUsuario();
    const conns = await Promise.all(Array.from({ length: 10 }, () => db.conn()));
    const rs = await Promise.all(conns.map((c) => c.query(`SELECT public.daily_claim($1, NULL, NULL) AS r`, [u]).then((x) => x.rows[0].r)));
    const ganhou = rs.filter((r) => r.status === "claimed");
    eq(ganhou.length, 1);
    const fins = await Promise.all(conns.map((c) => c.query(`SELECT public.daily_finish_ok($1,$2,$3,'p',5,90) AS r`, [u, HORA, ganhou[0].claim_id]).then((x) => x.rows[0].r)));
    eq(fins.filter((f) => f.status === "recorded").length, 1);
    eq(await tentativas(u), 1);
    await Promise.all(conns.map((c) => c.end()));
  });
}

await t("7a. reserva vencida: outra reserva assume; a resposta ATRASADA da 1ª vira 'stale' e NÃO grava", async () => {
  const u = await novoUsuario();
  const a = await claim(u);
  await db.q(`UPDATE public.daily_eval_claims SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u]);
  const b = await claim(u);
  eq(b.status, "claimed");
  ok(a.claim_id !== b.claim_id, "mesmo claim");
  eq((await finishOk(u, a.claim_id)).status, "stale");
  eq(await tentativas(u), 0);
  eq((await finishOk(u, b.claim_id)).status, "recorded");
  eq(await tentativas(u), 1);
  eq((await finishOk(u, b.claim_id)).status, "stale", "2ª finalização do mesmo claim");
  eq(await tentativas(u), 1);
});

await t("7b. reserva vencida SEM substituta: a resposta tardia ainda grava (é a tentativa do jogador)", async () => {
  const u = await novoUsuario();
  const a = await claim(u);
  await db.q(`UPDATE public.daily_eval_claims SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u]);
  eq((await finishOk(u, a.claim_id)).status, "recorded");
});

// a hora vem do BANCO; para simular a virada, a reserva é "envelhecida" uma hora
const envelhece = (u) =>
  db.q(`UPDATE public.daily_eval_claims SET challenge_hour = challenge_hour - interval '1 hour' WHERE user_id = $1`, [u]);

await t("8. virada da hora: reserva da hora anterior → 'hour_changed', nada gravado, sem contar falha", async () => {
  const u = await novoUsuario();
  const a = await claim(u);
  eq(a.status, "claimed");
  await envelhece(u);
  eq((await finishOk(u, a.claim_id, HORA_ANT)).status, "hour_changed");
  eq(await tentativas(u), 0);
  const l = await linha(u, HORA_ANT);
  eq([l.state, l.failures, l.last_failure_kind], ["failed", 0, "hour_changed"]);
  eq((await claim(u)).status, "claimed", "desafio novo");
});

await t("5/9. falha do PROVEDOR não gasta a tentativa; após 3 seguidas, pausa ('cooldown'); depois volta", async () => {
  const u = await novoUsuario();
  for (let i = 0; i < 3; i++) {
    const c = await claim(u);
    eq(c.status, "claimed", `tentativa ${i + 1}`);
    eq((await finishFail(u, c.claim_id, "provider")).status, "released");
  }
  eq(await tentativas(u), 0);
  eq((await claim(u)).status, "cooldown");
  await db.q(`UPDATE public.daily_eval_claims SET last_failure_at = now() - interval '3 minutes' WHERE user_id = $1`, [u]);
  const c = await claim(u);
  eq(c.status, "claimed");
  eq((await finishOk(u, c.claim_id)).status, "recorded");
});

await t("9b. falha NOSSA ('persist') não pune o jogador (sem pausa, sem disjuntor)", async () => {
  const u = await novoUsuario();
  const antes = (await db.q(`SELECT coalesce(sum(used),0)::int AS n FROM public.ai_quota WHERE key = 'daily_provider_fail'`))[0].n;
  for (let i = 0; i < 4; i++) {
    const c = await claim(u);
    eq(c.status, "claimed", `tentativa ${i + 1}`);
    await finishFail(u, c.claim_id, "persist");
  }
  eq((await linha(u)).failures, 0);
  eq((await db.q(`SELECT coalesce(sum(used),0)::int AS n FROM public.ai_quota WHERE key = 'daily_provider_fail'`))[0].n, antes);
});

await t("6/13. falha do banco DENTRO da gravação: transação desfeita (nada gravado), reserva segue 'running'; corrida recebe 'in_progress'; liberação 'persist' reabre", async () => {
  const u = randomUUID(); // SEM linha em auth.users → user_stats (FK) falha DEPOIS do insert em daily_attempts
  criados.push(u);
  const c = await claim(u);
  eq(c.status, "claimed");
  let erro = null;
  try {
    await finishOk(u, c.claim_id);
  } catch (e) {
    erro = e;
  }
  ok(erro, "deveria falhar");
  eq(await tentativas(u), 0, "rollback da tentativa");
  eq((await linha(u)).state, "running");
  eq((await claim(u)).status, "in_progress", "corrida durante a falha");
  eq((await finishFail(u, c.claim_id, "persist")).status, "released");
  eq((await claim(u)).status, "claimed", "reabre sem punir");
});

await t("11a. disjuntor global (aplicar): falhas do provedor de vários jogadores bloqueiam novas reservas SEM IA", async () => {
  await setCfg("daily_guard_breaker_fail_threshold", "2");
  await db.q(`DELETE FROM public.ai_quota WHERE key = 'daily_provider_fail'`);
  for (let i = 0; i < 2; i++) {
    const u = await novoUsuario();
    const c = await claim(u);
    await finishFail(u, c.claim_id, "provider");
  }
  const u3 = await novoUsuario();
  eq((await claim(u3)).status, "provider_unavailable");
  eq(await linha(u3), undefined, "não criou reserva");
});

await t("11b. disjuntor em modo OBSERVAR: registra 'would_block' e deixa passar", async () => {
  await modo("observar");
  const u = await novoUsuario();
  const c = await claim(u);
  eq([c.status, c.would_block], ["claimed", "provider_unavailable"]);
  await modo("aplicar");
  await setCfg("daily_guard_breaker_fail_threshold", "10");
  await db.q(`DELETE FROM public.ai_quota WHERE key = 'daily_provider_fail'`);
});

await t("11c. limite por usuário/dia (aplicar) e por origem/hora", async () => {
  await setCfg("daily_guard_user_evals_per_day", "2");
  const u = await novoUsuario();
  for (let i = 0; i < 2; i++) {
    const c = await claim(u);
    await finishFail(u, c.claim_id, "persist");
  }
  eq((await claim(u)).status, "rate_limited");
  await setCfg("daily_guard_user_evals_per_day", "30");
  await setCfg("daily_guard_origin_evals_per_hour", "1");
  const o = `origem-teste-${randomUUID()}`;
  eq((await claim(await novoUsuario(), HORA, o)).status, "claimed");
  eq((await claim(await novoUsuario(), HORA, o)).status, "rate_limited");
  eq((await claim(await novoUsuario(), HORA, null)).status, "claimed", "sem origem não limita");
  await setCfg("daily_guard_origin_evals_per_hour", "60");
});

await t("11d. modo OBSERVAR: nada é bloqueado — duplicado e já jogou viram 'pass_no_claim' (fluxo antigo, idêntico); hora virada grava como antes", async () => {
  await modo("observar");
  const u = await novoUsuario();
  const a = await claim(u);
  eq(a.status, "claimed");
  const b = await claim(u);
  eq([b.status, b.would_block], ["pass_no_claim", "in_progress"]);
  eq((await finishOk(u, a.claim_id)).status, "recorded");
  // já jogou: em observar NÃO renova a reserva 'done' (M1) → fluxo antigo, que chama a IA e
  // recebe already_played do submit, exatamente como antes da V2
  const c = await claim(u);
  eq([c.status, c.would_block], ["pass_no_claim", "already_played"]);
  const legado = (await db.q(`SELECT public.submit_daily_attempt_scored($1, 'p', 5, 90) AS r`, [u]))[0].r;
  eq(legado.already_played, true);
  eq(await tentativas(u), 1);
  // virada da hora em observar = comportamento antigo (grava na hora corrente)
  const v = await novoUsuario();
  const x = await claim(v);
  await envelhece(v);
  const fx = await finishOk(v, x.claim_id, HORA_ANT);
  eq([fx.status, fx.would_block], ["recorded", "hour_changed"]);
  await modo("aplicar");
});

await t("11e. modo DESLIGADO: 'bypass', sem reserva nem contagem; valor inválido de modo nunca vira 'aplicar'", async () => {
  await modo("desligado");
  const u = await novoUsuario();
  eq((await claim(u)).status, "bypass");
  eq(await linha(u), undefined);
  await modo("qualquer-coisa");
  eq((await claim(await novoUsuario())).mode, "observar");
  await modo("aplicar");
});

await t("12. pontuação, bônus e streak IDÊNTICOS ao submit_daily_attempt_scored direto (golden)", async () => {
  const via = await novoUsuario();
  const direto = await novoUsuario();
  for (const u of [via, direto])
    await db.q(`INSERT INTO public.user_stats (user_id, current_streak, best_streak, last_played_hour, total_score)
                VALUES ($1, 6, 6, date_trunc('hour', now()) - interval '1 hour', 500)
                ON CONFLICT (user_id) DO UPDATE SET current_streak = 6, best_streak = 6,
                  last_played_hour = EXCLUDED.last_played_hour, total_score = 500`, [u]);
  const c = await claim(via);
  const r1 = (await finishOk(via, c.claim_id, HORA, 87, "mesmo palpite", 33)).result;
  const r2 = (await db.q(`SELECT public.submit_daily_attempt_scored($1, 'mesmo palpite', 33, 87) AS r`, [direto]))[0].r;
  eq(r1, r2, "resultado");
  eq(r1.current_streak, 7);
  ok(r1.unlocked.includes("streak_7"), "conquista");
  const pick = async (u) => (await db.q(`SELECT score, is_correct, similarity, time_seconds FROM public.daily_attempts WHERE user_id = $1`, [u]))[0];
  eq(await pick(via), await pick(direto), "daily_attempts");
  const st = async (u) => (await db.q(`SELECT current_streak, best_streak, total_score FROM public.user_stats WHERE user_id = $1`, [u]))[0];
  eq(await st(via), await st(direto), "user_stats");
  for (const sim of [79, 80, 0, 100]) {
    const a = await novoUsuario();
    const b = await novoUsuario();
    const cc = await claim(a);
    const x = (await finishOk(a, cc.claim_id, HORA, sim, "g", 50)).result;
    const y = (await db.q(`SELECT public.submit_daily_attempt_scored($1, 'g', 50, $2) AS r`, [b, sim]))[0].r;
    eq([x.is_correct, x.score, x.similarity], [y.is_correct, y.score, y.similarity], `nota ${sim}`);
  }
});

await t("9c. convidado anônimo (auth.users.is_anonymous = true) joga normalmente", async () => {
  const g = await novoUsuario(true);
  const c = await claim(g);
  eq(c.status, "claimed");
  eq((await finishOk(g, c.claim_id)).status, "recorded");
});

await t("10/B1. a hora é a do BANCO (a do Worker é ignorada) e usuário nulo é erro", async () => {
  const u = await novoUsuario();
  const r = (await db.q(`SELECT public.daily_claim($1, now() - interval '3 hours', NULL) AS r`, [u]))[0].r;
  eq(r.status, "claimed");
  eq(new Date(r.hour).toISOString(), new Date(HORA).toISOString(), "hora devolvida");
  ok(await linha(u, HORA), "reserva na hora do banco");
  let e2 = null;
  try { await db.q(`SELECT public.daily_claim(NULL, date_trunc('hour', now()), NULL)`); } catch (e) { e2 = e; }
  ok(e2, "aceitou usuário nulo");
});

await t("M2. reserva nova (nunca falhou) tem precedência: 'in_progress' antes do disjuntor e dos limites", async () => {
  const u = await novoUsuario();
  eq((await claim(u)).status, "claimed");
  await setCfg("daily_guard_breaker_fail_threshold", "1");
  await db.q(`DELETE FROM public.ai_quota WHERE key = 'daily_provider_fail'`);
  const x = await novoUsuario();
  const cx = await claim(x);
  await finishFail(x, cx.claim_id, "provider"); // abre o disjuntor (limiar 1)
  eq((await claim(u)).status, "in_progress", "precedência");
  await setCfg("daily_guard_breaker_fail_threshold", "10");
  await db.q(`DELETE FROM public.ai_quota WHERE key = 'daily_provider_fail'`);
});

await t("M1. reserva 'done' nunca é renovada (sem 2ª IA), mesmo se a tentativa sumir", async () => {
  const u = await novoUsuario();
  const c = await claim(u);
  await finishOk(u, c.claim_id);
  await db.q(`DELETE FROM public.daily_attempts WHERE user_id = $1`, [u]);
  eq((await claim(u)).status, "in_progress");
  eq((await linha(u)).state, "done");
});

await t("A3. disjuntor: 'invalid' (resposta fora do formato) NÃO conta; várias falhas do MESMO jogador contam 1", async () => {
  await db.q(`DELETE FROM public.ai_quota WHERE key = 'daily_provider_fail'`);
  const total = async () => (await db.q(`SELECT coalesce(sum(used),0)::int AS n FROM public.ai_quota WHERE key = 'daily_provider_fail'`))[0].n;
  const u = await novoUsuario();
  for (let i = 0; i < 3; i++) {
    const c = await claim(u);
    eq(c.status, "claimed", `invalid ${i + 1}`);
    await finishFail(u, c.claim_id, "invalid");
  }
  eq(await total(), 0, "invalid contou no disjuntor");
  eq((await linha(u)).failures, 3, "invalid conta para o jogador");
  eq((await claim(u)).status, "cooldown");
  const v = await novoUsuario();
  for (let i = 0; i < 3; i++) {
    const c = await claim(v);
    await finishFail(v, c.claim_id, "provider");
  }
  eq(await total(), 1, "o mesmo jogador contou mais de 1");
});

await t("B5. configurações perigosas não desligam a proteção (mínimos seguros)", async () => {
  await setCfg("daily_guard_claim_ttl_s", "0");
  await setCfg("daily_guard_breaker_fail_threshold", "0");
  await setCfg("daily_guard_user_evals_per_day", "0");
  await db.q(`DELETE FROM public.ai_quota WHERE key = 'daily_provider_fail'`);
  const u = await novoUsuario();
  const c = await claim(u);
  eq(c.status, "claimed", "limiar/limite 0 bloquearam todos");
  const l = await linha(u);
  ok(new Date(l.expires_at) - new Date(l.started_at) >= 19000, "TTL abaixo do mínimo");
  eq((await claim(u)).status, "in_progress");
  await setCfg("daily_guard_claim_ttl_s", "45");
  await setCfg("daily_guard_breaker_fail_threshold", "10");
  await setCfg("daily_guard_user_evals_per_day", "48");
});

await t("15. telemetria sem dados pessoais: nenhum usuário, palpite, palavra ou definição em ops_events", async () => {
  const ev = await db.q(`SELECT payload::text AS p FROM public.ops_events WHERE kind = 'daily_guard'`);
  ok(ev.length > 10, "sem eventos");
  const usuarios = (await db.q(`SELECT id::text AS id FROM auth.users`)).map((r) => r.id);
  const texto = ev.map((e) => e.p).join("\n");
  for (const s of [...usuarios, "palpite de teste", "mesmo palpite", "palavra-teste", "definição-teste"]) ok(!texto.includes(s), `vazou: ${s}`);
});

await t("16. ROLLBACK: remove tudo da V2 sem tocar em daily_attempts/user_stats; reaplicar funciona", async () => {
  const antes = (await db.q(`SELECT count(*)::int AS n FROM public.daily_attempts`))[0].n;
  const stats = (await db.q(`SELECT count(*)::int AS n FROM public.user_stats`))[0].n;
  await db.exec(ROLLBACK);
  eq((await db.q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('daily_claim','daily_finish_ok','daily_finish_fail','ai_quota_add','ai_quota_used','daily_guard_mode','daily_guard_int','daily_guard_log','daily_guard_cleanup')`))[0].n, 0);
  eq((await db.q(`SELECT to_regclass('public.daily_eval_claims') AS t`))[0].t, null);
  eq((await db.q(`SELECT count(*)::int AS n FROM public.app_config WHERE key LIKE 'daily_guard_%'`))[0].n, 0);
  eq((await db.q(`SELECT count(*)::int AS n FROM public.daily_attempts`))[0].n, antes, "daily_attempts");
  eq((await db.q(`SELECT count(*)::int AS n FROM public.user_stats`))[0].n, stats, "user_stats");
  ok((await db.q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'submit_daily_attempt_scored'`))[0].n === 1, "pontuação intacta");
  await db.exec(MIG);
  await db.exec(MIG); // idempotente
  eq((await db.q(`SELECT value FROM public.app_config WHERE key = 'daily_guard_mode'`))[0].value, "observar");
  eq((await claim(await novoUsuario())).status, "claimed");
});

if (modePg) {
  // o teste com conexões reais NÃO pode "passar" sem ter rodado
  if (pgSo < 6) {
    fail++;
    falhas.push(`só ${pgSo} de 6 testes com conexões independentes rodaram`);
  }
  // limpeza dos dados de teste (o banco da CI segue para outras suítes)
  await db.q(`DELETE FROM public.daily_eval_claims WHERE user_id = ANY($1::uuid[])`, [criados]);
  await db.q(`DELETE FROM public.ai_quota WHERE key = ANY(SELECT 'daily_user:' || unnest($1::text[]))`, [criados]);
  await db.q(`DELETE FROM public.ai_quota WHERE key LIKE 'daily_origin:origem-teste-%' OR key = 'daily_provider_fail'`);
  await db.q(`DELETE FROM public.daily_attempts WHERE user_id = ANY($1::uuid[])`, [criados]);
  await db.q(`DELETE FROM public.user_achievements WHERE user_id = ANY($1::uuid[])`, [criados]);
  await db.q(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [criados]);
  console.log(`\n(conexões independentes: ${pgSo} testes executados; ${criados.length} usuários de teste removidos)`);
}
await db.close();
console.log(`\n${pass} passaram, ${fail} falharam${fail ? ": " + falhas.join(" | ") : ""}`);
process.exitCode = fail ? 1 : 0;
