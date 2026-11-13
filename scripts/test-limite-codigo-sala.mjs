// ECA R6 (12/11/2026) — limite de tentativas de código de sala
// (20261112090000_limite_tentativas_codigo_sala.sql). Confere no banco, com
// sessões simuladas (request.jwt.claims):
//   * entrada válida não soma falha; código inexistente e sala trancada somam;
//   * no limite → "rate_limited" com retry_after_secs, sem somar mais; vale
//     até para código válido de sala onde a pessoa NÃO está;
//   * reconexão de quem já está na sala nunca é barrada;
//   * isolamento entre identidades; janela andando libera; retenção apaga o
//     que passou de 1 hora; registro só com hash (nenhum uid em claro);
//   * chamada interna sem sessão de API mantém o erro room_not_found; anon
//     sem sessão segue recusado (session_required);
//   * tabelas e funções internas fechadas; rollback devolve o rejoin_room
//     anterior byte a byte;
//   * CORRIDA REAL (conexões independentes, transações confirmadas): 20
//     tentativas simultâneas da mesma identidade = exatamente 10 falhas
//     gravadas e 10 "rate_limited"; outra identidade em paralelo não é
//     afetada; entradas válidas simultâneas de outras pessoas passam.
// Parte 1 numa transação desfeita; parte 2 confirma e limpa o que criou.
// Envs: DB_URL.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
const claims = (uid) => `SET LOCAL request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'`;
const as = async (uid, sql, p = []) => {
  await db.query("SAVEPOINT a");
  try {
    await db.query(claims(uid));
    const r = (await db.query(sql, p)).rows[0];
    await db.query("RELEASE SAVEPOINT a");
    return { ok: true, v: r?.v };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT a");
    return { ok: false, error: e.message };
  } finally {
    await db.query(`SET LOCAL request.jwt.claims = ''`).catch(() => {});
  }
};
const JOIN = `SELECT public.rejoin_room($1, $2, 'Quem', 'x', '#000') v`;
const join = (uid, code, pid) => as(uid, JOIN, [code, pid]);
const entered = (r) => r.ok && r.v?.ok !== false && !!r.v?.id;
const reason = (r) => (r.ok ? r.v?.reason : r.error);
const tag = Math.random().toString(36).slice(2, 7);
const missing = (i) => `X${tag}${i}`; // nunca é código de sala (4 dígitos)

const lim = await row("SELECT max_failures, window_secs, retention_secs FROM public.room_code_limit()");
check("parâmetros: 10 falhas, janela 15 min, retenção 1 h", lim.max_failures === 10 && lim.window_secs === 900 && lim.retention_secs === 3600, JSON.stringify(lim));
const MAX = lim.max_failures;

// ---------------------------------------------------------------------------
// Parte 1 — regras (transação desfeita)
await db.query("BEGIN");
try {
  // rooms.locked vem do #69; sem ele (este PR sozinho), a coluna é criada só
  // dentro desta transação para provar a leitura por to_jsonb.
  const hadLocked = (
    await row(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'locked'`)
  ).n === 1;
  if (!hadLocked) await db.query(`ALTER TABLE public.rooms ADD COLUMN locked boolean NOT NULL DEFAULT false`);

  const [U1, U2, U3] = [randomUUID(), randomUUID(), randomUUID()];
  const mk = async (suffix, locked = false) => {
    const r = await row(
      `INSERT INTO public.rooms (code, host_id, status) VALUES ($1, $2, 'lobby') RETURNING id, code`,
      [`L${suffix}${tag}`, `lc_h${suffix}_${tag}`],
    );
    await db.query(
      `INSERT INTO public.players (id, room_id, nickname, avatar, color) VALUES ($1, $2, 'Dona', 'x', '#000')`,
      [`lc_h${suffix}_${tag}`, r.id],
    );
    if (locked) await db.query(`UPDATE public.rooms SET locked = true WHERE id = $1`, [r.id]);
    return r;
  };
  const R = await mk("a");
  const R2 = await mk("b");
  const RL = await mk("c", true);
  const hashOf = async (uid) => (await row("SELECT public.room_code_uid_hash($1) h", [uid])).h;
  const count = async (uid) =>
    (await row("SELECT count(*)::int n FROM public.room_code_failures WHERE uid_hash = $1", [await hashOf(uid)])).n;

  const a = await join(U1, R.code, `lc_a_${tag}`);
  check("código válido: entra", entered(a), reason(a));
  check("entrada válida não soma falha", (await count(U1)) === 0);

  const nf = [];
  for (let i = 0; i < MAX - 1; i++) nf.push(await join(U1, missing(i), `lc_x_${tag}`));
  check(
    `código inexistente: devolve {ok:false, reason:'room_not_found'} (${MAX - 1}x)`,
    nf.every((r) => r.ok && r.v?.ok === false && r.v.reason === "room_not_found"),
    nf.map(reason).join(","),
  );
  check(`${MAX - 1} falhas gravadas`, (await count(U1)) === MAX - 1, String(await count(U1)));

  const lk = await join(U1, RL.code, `lc_l_${tag}`);
  check("sala trancada para quem não está nela: room_locked e soma falha", reason(lk) === "room_locked" && (await count(U1)) === MAX, `${reason(lk)} n=${await count(U1)}`);
  const inLocked = await row(`SELECT count(*)::int n FROM public.players WHERE id = $1`, [`lc_l_${tag}`]);
  check("sala trancada: ninguém entrou", inLocked.n === 0);

  const blocked = await join(U1, missing("z"), `lc_x_${tag}`);
  check(
    "no limite: rate_limited com retry_after_secs (1..900)",
    reason(blocked) === "rate_limited" && blocked.v.retry_after_secs >= 1 && blocked.v.retry_after_secs <= 900,
    JSON.stringify(blocked.v ?? blocked.error),
  );
  check("barrado não soma mais falhas", (await count(U1)) === MAX, String(await count(U1)));

  const valid2 = await join(U1, R2.code, `lc_b_${tag}`);
  check("barrado: nem código válido de outra sala entra (não revela se existe)", reason(valid2) === "rate_limited", reason(valid2));
  const back = await join(U1, R.code, `lc_a_${tag}`);
  check("barrado: reconexão na sala onde já está passa", entered(back), reason(back));

  const o1 = await join(U2, missing("y"), `lc_y_${tag}`);
  const o2 = await join(U2, R2.code, `lc_o_${tag}`);
  check("isolamento: outra identidade não herda o bloqueio", reason(o1) === "room_not_found" && entered(o2), `${reason(o1)} ${reason(o2)}`);

  const h1 = await hashOf(U1);
  const plain = createHash("sha256").update(U1).digest("hex");
  const leak = await row(
    `SELECT count(*)::int n FROM public.room_code_failures WHERE uid_hash IN ($1, $2, $3)`,
    [U1, plain, U1.replace(/-/g, "")],
  );
  const cols = (
    await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'room_code_failures' ORDER BY ordinal_position`)
  ).rows.map((x) => x.column_name);
  check(
    "registro pseudonimizado: só hash com sal (64 hex) e hora; nenhum uid em claro",
    /^[0-9a-f]{64}$/.test(h1) && h1 !== plain && leak.n === 0 && cols.join(",") === "id,uid_hash,created_at",
    cols.join(","),
  );

  await db.query(
    `UPDATE public.room_code_failures SET created_at = created_at - make_interval(secs => $2) WHERE uid_hash = $1`,
    [h1, lim.window_secs + 60],
  );
  const after = await join(U1, missing("w"), `lc_x_${tag}`);
  check("janela andou: libera (volta a room_not_found)", reason(after) === "room_not_found", reason(after));

  await db.query(`INSERT INTO public.room_code_failures (uid_hash, created_at) VALUES ($1, now() - interval '2 hours')`, ["0".repeat(64)]);
  await join(U2, missing("v"), `lc_y_${tag}`);
  const old = await row(`SELECT count(*)::int n FROM public.room_code_failures WHERE created_at < now() - make_interval(secs => $1)`, [lim.retention_secs]);
  check("retenção: falha com mais de 1 hora é apagada na próxima gravação", old.n === 0, `restaram ${old.n}`);
  await db.query(`INSERT INTO public.room_code_failures (uid_hash, created_at) VALUES ($1, now() - interval '61 minutes'), ($1, now())`, ["1".repeat(64)]);
  const cl = (await row("SELECT public.room_code_failures_cleanup() n")).n;
  const keep = await row(`SELECT count(*)::int n FROM public.room_code_failures WHERE uid_hash = $1`, ["1".repeat(64)]);
  const cron = await row(
    `SELECT (SELECT count(*)::int FROM pg_namespace WHERE nspname = 'cron') has_cron,
            CASE WHEN to_regclass('cron.job') IS NULL THEN 0
                 ELSE (SELECT count(*)::int FROM cron.job WHERE jobname = 'verbete-room-code-failures-cleanup') END job`,
  ).catch(() => ({ has_cron: 0, job: 0 }));
  check(
    "retenção sem tráfego: limpeza agendada (pg_cron) apaga só o que passou de 1 hora",
    cl >= 1 && keep.n === 1 && (cron.has_cron === 0 || cron.job === 1),
    `apagadas=${cl} ficou=${keep.n} cron=${JSON.stringify(cron)}`,
  );

  const before = await row(`SELECT count(*)::int n FROM public.room_code_failures`);
  await db.query("SAVEPOINT i");
  let internal = null;
  try {
    await db.query(JOIN, [missing("i"), `lc_i_${tag}`]);
  } catch (e) {
    internal = e.message;
  }
  await db.query("ROLLBACK TO SAVEPOINT i");
  const afterInt = await row(`SELECT count(*)::int n FROM public.room_code_failures`);
  check("chamada interna (sem sessão de API): erro room_not_found de sempre, sem registro", /room_not_found/.test(internal ?? "") && before.n === afterInt.n, internal);

  await db.query("SAVEPOINT n");
  let anonErr = null;
  try {
    await db.query("SET LOCAL ROLE anon");
    await db.query(JOIN, [R.code, `lc_n_${tag}`]);
  } catch (e) {
    anonErr = e.message;
  }
  await db.query("ROLLBACK TO SAVEPOINT n");
  check("anon sem sessão continua recusado (session_required)", /session_required/.test(anonErr ?? ""), anonErr);

  const g = await row(
    `SELECT bool_or(has_table_privilege(r, t, p)) leak
       FROM unnest(ARRAY['anon','authenticated']) r,
            unnest(ARRAY['public.room_code_failures','public.room_code_failure_salt']) t,
            unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
  );
  const f = await row(
    `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public' AND p.proname IN ('room_code_limit','room_code_uid_hash','room_code_retry_after','room_code_record_failure','room_code_failures_cleanup')
        AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
  );
  const rj = await row(`SELECT has_function_privilege('authenticated', 'public.rejoin_room(text,text,text,text,text)', 'EXECUTE') x`);
  check("tabelas e funções internas fechadas; rejoin_room segue para authenticated", !g.leak && f.n === 0 && rj.x, `tabela=${g.leak} funções=${f.n} rejoin=${rj.x}`);

  // Rollback: rejoin_room volta byte a byte à versão de 20261021170000.
  const prev = readFileSync("supabase/migrations/20261021170000_player_id_one_room.sql", "utf8");
  const prevBody = /CREATE OR REPLACE FUNCTION public\.rejoin_room[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/.exec(prev)[1];
  await db.query(readFileSync("supabase/rollback/limite_tentativas_codigo_sala.sql", "utf8"));
  const src = await row(`SELECT prosrc FROM pg_proc WHERE oid = 'public.rejoin_room(text,text,text,text,text)'::regprocedure`);
  const gone = await row(
    `SELECT to_regclass('public.room_code_failures') a, to_regclass('public.room_code_failure_salt') b,
            to_regprocedure('public.room_code_retry_after(text)') c,
            to_regprocedure('public.room_code_failures_cleanup()') d`,
  );
  const rb = await join(U3, missing("r"), `lc_r_${tag}`);
  const cronGone = await row(
    `SELECT CASE WHEN to_regclass('cron.job') IS NULL THEN 0
                 ELSE (SELECT count(*)::int FROM cron.job WHERE jobname = 'verbete-room-code-failures-cleanup') END n`,
  ).catch(() => ({ n: 0 }));
  check("rollback: agendamento da limpeza sai", cronGone.n === 0, String(cronGone.n));
  check(
    "rollback: rejoin_room anterior byte a byte; tabelas e funções saem; inexistente volta a ser erro",
    src.prosrc === prevBody && !gone.a && !gone.b && !gone.c && !gone.d && !rb.ok && /room_not_found/.test(rb.error ?? ""),
    `${src.prosrc === prevBody} ${JSON.stringify(gone)} ${reason(rb)}`,
  );
} catch (e) {
  check("parte 1 rodou até o fim", false, e.message);
} finally {
  await db.query("ROLLBACK").catch(() => {});
}

// ---------------------------------------------------------------------------
// Parte 2 — corrida real: conexões independentes, transações confirmadas.
const UC = randomUUID();
const UD = randomUUID();
const joiners = Array.from({ length: 5 }, () => randomUUID());
let RC = null;
const clients = [];
try {
  RC = await row(
    `INSERT INTO public.rooms (code, host_id, status) VALUES ($1, $2, 'lobby') RETURNING id, code`,
    [`C${tag}`, `lc_hc_${tag}`],
  );
  await db.query(`INSERT INTO public.players (id, room_id, nickname, avatar, color) VALUES ($1, $2, 'Dona', 'x', '#000')`, [`lc_hc_${tag}`, RC.id]);

  const once = async (uid, code, pid) => {
    const c = new pg.Client({ connectionString: DB_URL, ssl });
    clients.push(c);
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(claims(uid));
      const v = (await c.query(JOIN, [code, pid])).rows[0].v;
      await c.query("COMMIT");
      return { ok: true, v };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      return { ok: false, error: e.message };
    } finally {
      await c.end().catch(() => {});
    }
  };
  const jobs = [
    ...Array.from({ length: 20 }, (_, i) => once(UC, missing(`c${i}`), `lc_cx_${tag}`).then((r) => ["C", r])),
    ...Array.from({ length: 8 }, (_, i) => once(UD, missing(`d${i}`), `lc_dx_${tag}`).then((r) => ["D", r])),
    ...joiners.map((u, i) => once(u, RC.code, `lc_j${i}_${tag}`).then((r) => ["J", r])),
  ];
  const res = await Promise.all(jobs);
  const tally = (who, why) => res.filter(([w, r]) => w === who && reason(r) === why).length;
  const nC = (await row("SELECT count(*)::int n FROM public.room_code_failures WHERE uid_hash = public.room_code_uid_hash($1)", [UC])).n;
  const nD = (await row("SELECT count(*)::int n FROM public.room_code_failures WHERE uid_hash = public.room_code_uid_hash($1)", [UD])).n;
  check(
    `corrida: 20 simultâneas da mesma identidade = ${MAX} room_not_found + ${20 - MAX} rate_limited, ${MAX} gravadas`,
    tally("C", "room_not_found") === MAX && tally("C", "rate_limited") === 20 - MAX && nC === MAX,
    `nf=${tally("C", "room_not_found")} rl=${tally("C", "rate_limited")} gravadas=${nC}`,
  );
  check(
    "corrida: outra identidade em paralelo (8) não é afetada",
    tally("D", "room_not_found") === 8 && nD === 8,
    `nf=${tally("D", "room_not_found")} gravadas=${nD}`,
  );
  const okJ = res.filter(([w, r]) => w === "J" && entered(r)).length;
  check("corrida: 5 entradas válidas simultâneas de outras pessoas passam", okJ === 5, `${okJ}/5`);
} catch (e) {
  check("parte 2 rodou até o fim", false, e.message);
} finally {
  await Promise.all(clients.map((c) => c.end().catch(() => {})));
  await db
    .query(
      `DELETE FROM public.room_code_failures WHERE uid_hash IN (SELECT public.room_code_uid_hash(u) FROM unnest($1::uuid[]) u)`,
      [[UC, UD, ...joiners]],
    )
    .catch(() => {});
  if (RC) {
    await db.query(`DELETE FROM public.players WHERE room_id = $1`, [RC.id]).catch(() => {});
    await db.query(`DELETE FROM public.rooms WHERE id = $1`, [RC.id]).catch(() => {});
  }
  const left = await row(
    `SELECT count(*)::int n FROM public.room_code_failures WHERE uid_hash IN (SELECT public.room_code_uid_hash(u) FROM unnest($1::uuid[]) u)`,
    [[UC, UD, ...joiners]],
  ).catch(() => ({ n: -1 }));
  check("limpeza: nada desta suíte ficou no banco", left.n === 0, String(left.n));
  await db.end();
}
console.log(`\n${total - fails}/${total} verificações OK`);
process.exit(fails ? 1 : 0);
