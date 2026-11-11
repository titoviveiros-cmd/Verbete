// Limite de criação de salas por jogador + liberação de código (11/11/2026):
//   migration 20261111100000_limite_salas_por_jogador
// Conexões REAIS independentes (corrida no teto e na liberação só existem
// entre sessões). Grava de verdade e limpa tudo no fim (prefixo por execução).
//
//   node scripts/test-limite-salas.mjs        (DB_URL = Postgres LOCAL já migrado)
// Recusa qualquer DB_URL que não seja local.
import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const MIG = rd("supabase/migrations/20261111100000_limite_salas_por_jogador.sql");
const RB = rd("supabase/rollback/limite_salas_por_jogador.sql");
// md5(prosrc) dos corpos da 20261111090000 (PR #60): o rollback devolve estes.
const PR60_MD5 = {
  create_room_with_host: "021839b1425e2d7f808066209801bafc",
  join_public_room: "2e3bc9a11f3c99de81f2bb4c7ed18606",
};

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
const tag = "ls" + Math.random().toString(36).slice(2, 7);
const uids = [];
const newUid = () => {
  const u = randomUUID();
  uids.push(u);
  return u;
};
const who = (u) => createHash("sha256").update(u).digest();
const msg = (e) => String(e?.message ?? e);

/** Uma chamada como a API faria: papel authenticated + claims da sessão. */
async function asUser(c, uid, sql, params = []) {
  await c.query("BEGIN");
  try {
    await c.query("SET LOCAL ROLE authenticated");
    await c.query(`SET LOCAL request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'`);
    const { rows } = await c.query(sql, params);
    await c.query("COMMIT");
    return rows[0];
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
let seq = 0;
const create = (c, uid) =>
  asUser(c, uid, `SELECT id, code, host_id FROM public.create_room_with_host($1, 'Teste', 'x', '#000')`, [`${tag}_p${seq++}`]);
const quick = (c, uid) =>
  asUser(c, uid, `SELECT id, code, host_id FROM public.join_public_room($1, 'Teste', 'x', '#000')`, [`${tag}_p${seq++}`]);
const tryCall = async (fn) => {
  try {
    return { ok: true, r: await fn() };
  } catch (e) {
    return { ok: false, e: msg(e) };
  }
};

async function cleanup() {
  await db.query(`DELETE FROM public.players WHERE id LIKE $1`, [`${tag}%`]);
  await db.query(`DELETE FROM public.rooms WHERE host_id LIKE $1`, [`${tag}%`]);
  if (uids.length) await db.query(`DELETE FROM public.room_create_log WHERE who = ANY($1::bytea[])`, [uids.map(who)]);
}

// a migration está aplicada?
const [{ ok: aplicada }] = await q(`SELECT to_regprocedure('public.room_create_guard(uuid)') IS NOT NULL AS ok`);
if (!aplicada) {
  console.error("✖ room_create_guard ausente: aplique a 20261111100000 antes.");
  process.exit(1);
}

try {
  // ------------------------------------------------ 1) tetos de uma identidade
  {
    const A = newUid();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await create(db, A));
    check("A cria 5 salas (vivas) normalmente", made.length === 5 && new Set(made.map((r) => r.code)).size === 5);
    let r = await tryCall(() => create(db, A));
    check("6ª sala viva → room_rate_limited", !r.ok && /room_rate_limited/.test(r.e), r.e ?? "criou!");
    r = await tryCall(() => quick(db, A));
    check("partida rápida que CRIA também respeita o teto", !r.ok && /room_rate_limited/.test(r.e), r.e ?? "criou!");
    const B = newUid();
    r = await tryCall(() => create(db, B));
    check("outra identidade (B) não é afetada", r.ok, r.e ?? "");

    // id já usado → player_id_taken, e a tentativa NÃO consome cota
    const [{ n: antes }] = await q(`SELECT count(*)::int n FROM public.room_create_log WHERE who = $1`, [who(B)]);
    r = await tryCall(() => asUser(db, B, `SELECT public.create_room_with_host($1, 'X', 'x', '#000')`, [made[0].host_id]));
    const [{ n: depois }] = await q(`SELECT count(*)::int n FROM public.room_create_log WHERE who = $1`, [who(B)]);
    check("player_id_taken não consome cota", !r.ok && /player_id_taken/.test(r.e) && depois === antes, `${r.e} log ${antes}→${depois}`);

    // as 5 salas de A terminam (partida jogada): o teto passa a ser o da hora (12)
    await db.query(`UPDATE public.rooms SET status = 'finished' WHERE id = ANY($1::uuid[])`, [made.map((x) => x.id)]);
    let extra = 0;
    let last = null;
    for (let i = 0; i < 10; i++) {
      const t = await tryCall(() => create(db, A));
      if (t.ok) {
        extra++;
        await db.query(`UPDATE public.rooms SET status = 'finished' WHERE id = $1`, [t.r.id]);
      } else last = t.e;
    }
    check("teto por hora: 12 criações (5 + 7) e a 13ª recusa", extra === 7 && /room_rate_limited/.test(last ?? ""), `extra=${extra} ${last}`);

    // teto por dia (40): criações antigas (2 h atrás) contam no dia, não na hora
    const C = newUid();
    await db.query(`INSERT INTO public.room_create_log (who, at) SELECT $1, now() - interval '2 hours' FROM generate_series(1, 39)`, [who(C)]);
    r = await tryCall(() => create(db, C));
    check("40ª do dia passa", r.ok, r.e ?? "");
    if (r.ok) await db.query(`UPDATE public.rooms SET status = 'finished' WHERE id = $1`, [r.r.id]);
    r = await tryCall(() => create(db, C));
    check("41ª do dia → room_rate_limited", !r.ok && /room_rate_limited/.test(r.e), r.e ?? "criou!");

    // entrar num lobby público existente NÃO conta
    const D = newUid();
    const lobby = await quick(db, D); // D cria (não há lobby público do teste… ou entra num)
    const E = newUid();
    const [{ n: e0 }] = await q(`SELECT count(*)::int n FROM public.room_create_log WHERE who = $1`, [who(E)]);
    const joined = await quick(db, E);
    const [{ n: e1 }] = await q(`SELECT count(*)::int n FROM public.room_create_log WHERE who = $1`, [who(E)]);
    const eCriou = joined.host_id.startsWith(`${tag}_p`) && joined.id !== lobby.id && (await q(`SELECT 1 FROM public.players WHERE id = $1 AND room_id = $2`, [joined.host_id, joined.id])).length > 0 && joined.host_id === `${tag}_p${seq - 1}`;
    check("entrar num lobby público existente não consome cota (criar consome 1)", eCriou ? e1 === e0 + 1 : e1 === e0, `E ${eCriou ? "criou" : "entrou"} — log ${e0}→${e1}`);

    // retenção: linha com mais de 48 h some na próxima criação
    const F = newUid();
    await db.query(`INSERT INTO public.room_create_log (who, at) VALUES ($1, now() - interval '49 hours')`, [who(F)]);
    await create(db, F);
    const [{ n: velhas }] = await q(`SELECT count(*)::int n FROM public.room_create_log WHERE at < now() - interval '48 hours'`);
    check("retenção de 48 h aplicada na criação", velhas === 0, `restantes=${velhas}`);

    // service_role (sem auth.uid) não tem teto e não grava log
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE service_role");
    const [{ n: l0 }] = (await db.query(`SELECT count(*)::int n FROM public.room_create_log`)).rows;
    await db.query(`SELECT public.create_room_with_host($1, 'Srv', 'x', '#000')`, [`${tag}_srv`]);
    const [{ n: l1 }] = (await db.query(`SELECT count(*)::int n FROM public.room_create_log`)).rows;
    await db.query("ROLLBACK");
    check("service_role cria sem teto e sem registro", l1 === l0, `${l0}→${l1}`);
  }

  // --------------------------------- 2) corrida no teto: 20 chamadas da MESMA identidade
  {
    const U = newUid();
    const cs = [];
    for (let i = 0; i < 20; i++) cs.push(await conn());
    const res = await Promise.allSettled(cs.map((c) => create(c, U)));
    for (const c of cs) await c.end();
    const ok = res.filter((x) => x.status === "fulfilled").length;
    const errs = res.filter((x) => x.status === "rejected").map((x) => msg(x.reason));
    check("corrida: 20 simultâneas da mesma identidade → exatamente 5 criam", ok === 5, `ok=${ok}`);
    check("corrida: as outras 15 recebem room_rate_limited (nada cru)", errs.length === 15 && errs.every((m) => /room_rate_limited/.test(m)), [...new Set(errs)].join(" | "));
  }

  // ------- 3) ataque × jogo legítimo: 1 sessão tentando esgotar + 24 sessões legítimas
  {
    const ATK = newUid();
    const legit = Array.from({ length: 24 }, () => newUid());
    const atkConn = await conn();
    const legConns = [];
    for (let i = 0; i < legit.length; i++) legConns.push(await conn());
    let atkOk = 0;
    let atkErr = new Set();
    let stop = false;
    // o atacante sai da sala logo depois de criar (fura o teto de "vivas") e tenta de novo sem parar
    const atk = (async () => {
      for (let i = 0; i < 400 && !stop; i++) {
        try {
          const r = await create(atkConn, ATK);
          atkOk++;
          await asUser(atkConn, ATK, `SELECT public.leave_room($1)`, [r.host_id]);
        } catch (e) {
          atkErr.add(msg(e));
        }
      }
    })();
    const legRes = await Promise.allSettled(legConns.map((c, i) => create(c, legit[i])));
    // jogador legítimo que perdeu a conexão recria a sala 3 vezes
    const rec = [];
    for (let k = 0; k < 3; k++) rec.push(await tryCall(() => create(legConns[0], legit[0])));
    await atk;
    stop = true;
    await atkConn.end();
    for (const c of legConns) await c.end();
    const legOk = legRes.filter((x) => x.status === "fulfilled").length;
    check("ataque: 1 sessão (cria e sai, 400 tentativas) consegue no máx. 12 salas", atkOk === 12, `criou=${atkOk} erros=${[...atkErr].join(" | ")}`);
    check("ataque: o resto é room_rate_limited", [...atkErr].every((m) => /room_rate_limited/.test(m)));
    check("24 sessões legítimas em paralelo ao ataque: todas criam", legOk === 24, legRes.find((x) => x.status === "rejected")?.reason?.message ?? "");
    check("legítimo que recria a sala 3× depois de cair: tudo passa (4 vivas ≤ 5)", rec.every((x) => x.ok), rec.find((x) => !x.ok)?.e ?? "");
  }

  // ------------------- 4) liberação do código das salas encerradas pela LIMPEZA
  {
    const G = newUid();
    // ocupa TODOS os códigos livres com salas encerradas pela limpeza há 1 h
    await db.query(
      `INSERT INTO public.rooms (code, host_id, status, finish_reason, finished_at)
       SELECT g::text, $1 || 'f' || g, 'finished', 'cleanup_lobby', now() - interval '1 hour'
         FROM generate_series(1000, 9999) g
        WHERE NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.code = g::text)`,
      [tag],
    );
    // o gatilho rooms_track_finished_at grava finished_at = agora no INSERT: recua à parte
    await db.query(`UPDATE public.rooms SET finished_at = now() - interval '1 hour' WHERE host_id LIKE $1`, [`${tag}f%`]);
    const [{ n: alheias }] = await q(`SELECT count(*)::int n FROM public.rooms WHERE host_id NOT LIKE $1 AND status = 'finished' AND finish_reason IS NOT NULL AND finished_at < now() - interval '30 minutes' AND code ~ '^[0-9]{4}$'`, [`${tag}%`]);
    if (alheias) console.log(`  (aviso) ${alheias} sala(s) limpas de OUTRAS suítes também são liberáveis`);
    const [{ n: livres }] = await q(`SELECT count(*)::int n FROM generate_series(1000,9999) g WHERE NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.code = g::text)`);
    let r = await tryCall(() => create(db, G));
    const [arq] = r.ok ? await q(`SELECT count(*)::int n FROM public.rooms WHERE code = 'arq-' || id::text AND host_id LIKE $1`, [`${tag}f%`]) : [{ n: -1 }];
    check("tabela cheia de salas limpas há 1 h → cria liberando 1 código", livres === 0 && r.ok && arq.n === 1, `livres=${livres} ${r.e ?? r.r.code} arquivadas=${arq.n}`);
    if (r.ok) {
      const [old] = await q(`SELECT status, finish_reason FROM public.rooms WHERE code = 'arq-' || id::text AND host_id LIKE $1`, [`${tag}f%`]);
      check("a sala antiga fica intacta (só o código muda)", old?.status === "finished" && old?.finish_reason === "cleanup_lobby");
    }

    // corrida: 16 identidades diferentes ao mesmo tempo na tabela cheia
    const cs = [];
    const us = Array.from({ length: 16 }, () => newUid());
    for (let i = 0; i < 16; i++) cs.push(await conn());
    const res = await Promise.allSettled(cs.map((c, i) => create(c, us[i])));
    for (const c of cs) await c.end();
    const ok = res.filter((x) => x.status === "fulfilled").map((x) => x.value.code);
    const bad = res.filter((x) => x.status === "rejected").map((x) => msg(x.reason));
    const [{ n: arq2 }] = await q(`SELECT count(*)::int n FROM public.rooms WHERE code LIKE 'arq-%' AND host_id LIKE $1`, [`${tag}f%`]);
    check("corrida na liberação: 16 simultâneas → 16 criam, códigos distintos", ok.length === 16 && new Set(ok).size === 16, bad.slice(0, 2).join(" | "));
    check("corrida na liberação: exatamente 17 salas antigas arquivadas (1 + 16)", arq2 === 17, `n=${arq2}`);

    // não libera: limpeza há 5 min (folga) nem partida que terminou de verdade
    await db.query(`UPDATE public.rooms SET finished_at = now() - interval '5 minutes' WHERE host_id LIKE $1 AND code NOT LIKE 'arq-%'`, [`${tag}f%`]);
    r = await tryCall(() => create(db, newUid()));
    check("salas limpas há só 5 min NÃO liberam (folga de 30 min)", alheias > 0 || (!r.ok && /could not generate unique room code/.test(r.e)), r.e ?? `criou ${r.r?.code}`);
    await db.query(`UPDATE public.rooms SET finished_at = now() - interval '1 day', finish_reason = NULL WHERE host_id LIKE $1 AND code NOT LIKE 'arq-%'`, [`${tag}f%`]);
    r = await tryCall(() => create(db, newUid()));
    check("partida terminada de verdade (sem finish_reason) NUNCA libera o código", alheias > 0 || (!r.ok && /could not generate unique room code/.test(r.e)), r.e ?? `criou ${r.r?.code}`);
    // com partida real (cleanup_paused/idle/stale): folga de 6 h (pós Red Team #67)
    await db.query(`UPDATE public.rooms SET finish_reason = 'cleanup_paused', finished_at = now() - interval '3 hours' WHERE host_id LIKE $1 AND code NOT LIKE 'arq-%'`, [`${tag}f%`]);
    r = await tryCall(() => create(db, newUid()));
    check("partida pausada e limpa há 3 h NÃO libera (folga de 6 h)", alheias > 0 || (!r.ok && /could not generate unique room code/.test(r.e)), r.e ?? `criou ${r.r?.code}`);
    await db.query(`UPDATE public.rooms SET finished_at = now() - interval '7 hours' WHERE host_id LIKE $1 AND code NOT LIKE 'arq-%'`, [`${tag}f%`]);
    r = await tryCall(() => create(db, newUid()));
    const [p7] = r.ok ? await q(`SELECT finish_reason FROM public.rooms WHERE code LIKE 'arq-%' AND host_id LIKE $1 AND finish_reason = 'cleanup_paused'`, [`${tag}f%`]) : [];
    check("partida pausada e limpa há 7 h libera", r.ok && p7?.finish_reason === "cleanup_paused", r.e ?? r.r.code);
    // matriz da regra (função pura)
    const mat = (await q(`SELECT string_agg(m || '=' || public.room_code_releasable('finished', m, now() - d::interval)::text, ' ' ORDER BY m, d) s
      FROM unnest(ARRAY['cleanup_lobby','cleanup_empty','cleanup_idle','cleanup_stale','cleanup_paused']) m,
           unnest(ARRAY['29 minutes','31 minutes','5 hours 59 minutes','6 hours 1 minute']) d`))[0].s;
    const esperado = ["cleanup_empty", "cleanup_idle", "cleanup_lobby", "cleanup_paused", "cleanup_stale"].map((m) => {
      const curto = m === "cleanup_lobby" || m === "cleanup_empty";
      // ordem de d como texto: '29 minutes','31 minutes','5 hours 59 minutes','6 hours 1 minute'
      return [false, curto, curto, true].map((v) => `${m}=${v}`).join(" ");
    }).join(" ");
    check("regra: sem partida 30 min; com partida 6 h", mat === esperado, mat);
    const [{ x: nunca }] = await q(`SELECT public.room_code_releasable('finished', NULL, now() - interval '29 days') OR public.room_code_releasable('lobby', 'cleanup_lobby', now() - interval '1 day') OR public.room_code_releasable('finished', 'cleanup_lobby', NULL) AS x`);
    check("fim normal, sala viva ou sem finished_at: nunca", nunca === false);
    await db.query(`DELETE FROM public.rooms WHERE host_id LIKE $1`, [`${tag}f%`]);
  }

  // ---- 4b) código reciclado: o jogador ANTIGO não volta nem vê nada além do que qualquer um vê
  {
    const U_old = newUid();
    const U_new = newUid();
    const U_x = newUid();
    const old = await create(db, U_old);
    const pOld = old.host_id;
    const X = old.code;
    await db.query(`UPDATE public.rooms SET status = 'finished' WHERE id = $1`, [old.id]);
    await db.query(`UPDATE public.rooms SET finish_reason = 'cleanup_lobby', finished_at = now() - interval '1 hour' WHERE id = $1`, [old.id]);
    // todos os outros códigos livres viram partidas normais (nunca liberáveis): o próximo código só pode ser X
    await db.query(
      `INSERT INTO public.rooms (code, host_id, status)
       SELECT g::text, $1 || 'g' || g, 'finished' FROM generate_series(1000, 9999) g
        WHERE NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.code = g::text)`,
      [tag],
    );
    const nova = await create(db, U_new);
    check("a sala nova recebeu o código reciclado X", nova.code === X && nova.id !== old.id, `X=${X} nova=${nova.code}`);
    const [{ c: arqOld }] = await q(`SELECT code c FROM public.rooms WHERE id = $1`, [old.id]);
    check("a sala antiga ficou com 'arq-<id>'", arqOld === `arq-${old.id}`, arqOld);

    let r = await tryCall(() => asUser(db, U_old, `SELECT public.rejoin_room($1, $2, 'Velho', 'x', '#000') AS r`, [X, pOld]));
    check("rejoin_room do jogador antigo com X → player_id_taken (não entra na sala nova)", !r.ok && /player_id_taken/.test(r.e), r.e ?? JSON.stringify(r.r).slice(0, 80));
    const [{ room_id }] = await q(`SELECT room_id FROM public.players WHERE id = $1`, [pOld]);
    const [{ n: dentro }] = await q(`SELECT count(*)::int n FROM public.players WHERE room_id = $1 AND (user_id = $2 OR id = $3)`, [nova.id, U_old, pOld]);
    check("o jogador antigo continua na sala antiga e não aparece na nova", room_id === old.id && dentro === 0, `dentro=${dentro}`);

    const sOld = (await asUser(db, U_old, `SELECT public.get_room_state($1) AS s`, [X])).s;
    const sX = (await asUser(db, U_x, `SELECT public.get_room_state($1) AS s`, [X])).s;
    check("get_room_state(X): o antigo vê exatamente o que um estranho vê", JSON.stringify(sOld) === JSON.stringify(sX));
    check("get_room_state(X) é a sala NOVA, sem nada da antiga", sOld?.room?.id === nova.id && !sOld.players.some((p) => p.id === pOld) && sOld.definitions.length === 0 && sOld.votes.length === 0);

    r = await tryCall(() => asUser(db, U_old, `SELECT public.record_match_result($1) AS r`, [X]));
    const [{ n: hist }] = await q(`SELECT count(*)::int n FROM public.match_history WHERE user_id = $1`, [U_old]);
    check("record_match_result(X) pelo antigo não credita nada", r.ok && r.r.r?.ok === false && hist === 0, JSON.stringify(r.r?.r ?? r.e));
    await db.query(`DELETE FROM public.rooms WHERE host_id LIKE $1`, [`${tag}g%`]);
  }

  // --------------------------------------------- 5) privacidade e permissões
  {
    const priv = async (role, obj, kind) =>
      (await q(kind === "f" ? `SELECT has_function_privilege($1, $2, 'EXECUTE') x` : `SELECT has_table_privilege($1, $2, 'SELECT') x`, [role, obj]))[0].x;
    check("anon/authenticated NÃO leem room_create_log", !(await priv("anon", "public.room_create_log", "t")) && !(await priv("authenticated", "public.room_create_log", "t")));
    check("anon/authenticated NÃO executam room_create_guard", !(await priv("anon", "public.room_create_guard(uuid)", "f")) && !(await priv("authenticated", "public.room_create_guard(uuid)", "f")));
    check("criar sala segue aberto (anon executa create_room_with_host)", await priv("anon", "public.create_room_with_host(text, text, text, text)", "f"));
    const cols = (await q(`SELECT string_agg(attname, ',' ORDER BY attnum) s FROM pg_attribute WHERE attrelid = 'public.room_create_log'::regclass AND attnum > 0 AND NOT attisdropped`))[0].s;
    check("registro só com id, hash (32 B) e hora", cols === "id,who,at", cols);
    const [{ n: cru }] = await q(`SELECT count(*)::int n FROM public.room_create_log WHERE octet_length(who) <> 32 OR encode(who, 'escape') ~ '[0-9a-f]{8}-'`);
    check("nenhum uid cru no registro", cru === 0);
  }

  // ---------------------------- 6) rollback devolve os corpos do PR #60 e reaplica
  {
    await db.query("BEGIN");
    try {
      await db.query(RB);
      const md5 = Object.fromEntries((await q(`SELECT proname, md5(prosrc) m FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [Object.keys(PR60_MD5)])).map((r) => [r.proname, r.m]));
      for (const [f, m] of Object.entries(PR60_MD5)) check(`rollback devolve o corpo do PR #60: ${f}`, md5[f] === m, md5[f]);
      const [{ g, t, h }] = await q(`SELECT to_regprocedure('public.room_create_guard(uuid)') IS NULL g, to_regclass('public.room_create_log') IS NULL t, to_regprocedure('public.room_code_releasable(text,text,timestamptz)') IS NULL h`);
      check("rollback remove guard, regra e registro", g && t && h);
      await db.query(MIG);
      await db.query(MIG); // idempotente
      const [{ ok }] = await q(`SELECT to_regprocedure('public.room_create_guard(uuid)') IS NOT NULL ok`);
      check("migration reaplica (2×) depois do rollback", ok);
    } finally {
      await db.query("ROLLBACK");
    }
  }
} finally {
  await cleanup();
  const [{ n }] = await q(`SELECT count(*)::int n FROM public.rooms WHERE host_id LIKE $1`, [`${tag}%`]);
  check("limpeza (nenhuma sala do teste sobra)", n === 0, `n=${n}`);
  await db.end();
}
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
