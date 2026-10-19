// P2 XP — sala encerrada pela LIMPEZA não é partida. Quem abrir o pódio de
// uma sala que o cleanup_zombie_rooms encerrou (fase parada, lobby
// abandonado, sem humano conectado, R4 sem ação humana) não pode ganhar
// histórico, XP, nível, vitória, sequência, pontos nem conquista.
//
// Fim natural (finish_reveal / advance_scoreboard_to_next_round_or_finished:
// alvo de pontos ou de rodadas) e sala histórica sem motivo seguem EXATAMENTE
// como antes: o resultado é comparado, com os mesmos dados, contra a versão
// anterior de record_match_result (copiada da última migration que a definiu
// antes desta correção para um nome temporário).
//
// Também: dedup, revanche depois da limpeza, segurança do motivo (tabela,
// CHECK, REST), concorrência (advisory lock) e a lista FECHADA de funções
// que levam uma sala a 'finished' — caminho novo sem classificação reprova.
// Envs: DB_URL (Supabase local do CI); SUPA_URL + ANON opcionais (REST).
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";

const { DB_URL, SUPA_URL, ANON } = process.env;
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
const short = (x) => JSON.stringify(x ?? null).slice(0, 220);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tag = Math.random().toString(36).slice(2, 7);
const rooms = [];
const users = [];
let seq = 0;

// Versão de record_match_result que vigorava ANTES da correção do P2.
const P2_VERSION = "20261019030000";
function previousDefinition(fn) {
  const dir = "supabase/migrations";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < P2_VERSION)
    .sort();
  const head = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "gi");
  let found = null;
  for (const f of files) {
    const t = readFileSync(`${dir}/${f}`, "utf8").replace(/\r\n/g, "\n");
    for (const m of t.matchAll(head)) {
      const as = /AS\s+(\$[A-Za-z_]*\$)/g;
      as.lastIndex = m.index;
      const a = as.exec(t);
      const close = t.indexOf(a[1], a.index + a[0].length);
      found = { file: f, sql: `${t.slice(m.index, close + a[1].length)};` };
    }
  }
  return found;
}

async function mkUser() {
  const u = (await row(`SELECT gen_random_uuid() AS id`)).id;
  await db.query(
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [u, `p2_${tag}_${users.length}@test.local`],
  );
  users.push(u);
  return u;
}

// Partida curta: o humano acertou a verdade (+50 XP) e o bot caiu no blefe
// dele (+30 XP) — a fórmula inteira entra na comparação.
async function addGame(room, round, humanMin, botMin, startMin) {
  const truth = await row(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, $2, '__truth__', 'verdade', true, now() - make_interval(mins => $3)) RETURNING id`,
    [room.id, round, startMin],
  );
  const bluff = await row(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, $2, $3, 'blefe do humano', false, now() - make_interval(mins => $4)) RETURNING id`,
    [room.id, round, room.h, humanMin],
  );
  await db.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, $2, $3, 'blefe do bot', false, now() - make_interval(mins => $4))`,
    [room.id, round, room.b, botMin],
  );
  await db.query(
    `INSERT INTO public.votes (room_id, round, voter_id, definition_id, created_at) VALUES
       ($1, $2, $3, $4, now() - make_interval(mins => $5)),
       ($1, $2, $6, $7, now() - make_interval(mins => $8))`,
    [room.id, round, room.h, truth.id, humanMin, room.b, bluff.id, botMin],
  );
}

// Sala com 1 humano ligado ao usuário e 1 bot. humanMin = idade da última
// ação humana; createdMin = idade da sala (e da verdade da rodada 1).
async function mkRoom(uid, o) {
  const {
    status,
    round = 3,
    createdMin = 5,
    phaseMin = 0,
    humanMin = 0,
    botMin = 0,
    connected = true,
    score = 6,
    botScore = 3,
    win = "score",
    target = 15,
    game = true,
  } = o;
  seq++;
  const code = `P2${tag}${seq}`;
  const h = `p2_h_${tag}_${seq}`;
  const b = `p2_b_${tag}_${seq}`;
  const r = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, created_at, phase_started_at,
                               round_phase_ends_at, win_condition, win_target)
     VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5), now() - make_interval(mins => $6),
             now() + interval '60 seconds', $7, $8)
     RETURNING id`,
    [code, h, status, round, createdMin, phaseMin, win, target],
  );
  rooms.push(r.id);
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id, is_bot, is_connected,
                                 joined_at, score, coordinator_count)
     VALUES ($1, $3, 'Humano', 'h', '#000', $4, false, $5, now() - make_interval(mins => $6), $7, 1),
            ($2, $3, 'Bot', 'b', '#111', NULL, true, true, now() - make_interval(mins => $8), $9, 0)`,
    [h, b, r.id, uid, connected, humanMin, score, createdMin, botScore],
  );
  const room = { id: r.id, code, h, b };
  if (game) await addGame(room, 1, humanMin, botMin, createdMin);
  return room;
}

const roomState = (id) =>
  row(
    `SELECT status, current_round, to_jsonb(r) ->> 'finish_reason' AS reason FROM public.rooms r WHERE id = $1`,
    [id],
  );

// Tudo que o pódio pode tocar no usuário.
const snap = async (client, uid) =>
  (
    await client.query(
      `SELECT (SELECT to_jsonb(s) - 'updated_at' - 'created_at' FROM public.user_stats s WHERE s.user_id = $1) AS stats,
              (SELECT count(*)::int FROM public.match_history WHERE user_id = $1) AS history,
              (SELECT coalesce(jsonb_agg(achievement_code ORDER BY achievement_code), '[]'::jsonb)
                 FROM public.user_achievements WHERE user_id = $1) AS achievements`,
      [uid],
    )
  ).rows[0];

// Chama como o usuário logado (auth.uid() lê os claims). commit=false desfaz.
async function callAs(client, uid, fn, code, { commit = true } = {}) {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: uid, role: "authenticated" }),
    ]);
    const res = (await client.query(`SELECT public.${fn}($1) AS r`, [code])).rows[0].r;
    const after = await snap(client, uid);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return { res, after };
  } catch (e) {
    await client.query("ROLLBACK");
    return { error: e.message, code: e.code };
  }
}

// Cleanup: tem que encerrar com o motivo certo e o pódio não pode pagar nada.
async function expectNotRewardable(name, uid, room, reason) {
  const st = await roomState(room.id);
  check(`${name}: encerrada pela limpeza com motivo ${reason}`, st.status === "finished" && st.reason === reason, short(st));
  const before = await snap(db, uid);
  const got = await callAs(db, uid, "record_match_result", room.code);
  check(
    `${name}: pódio recusa recompensa (ok=false, match_not_rewardable, xp 0)`,
    got.res?.ok === false && got.res?.reason === "match_not_rewardable" && (got.res?.xp_gained ?? 0) === 0,
    short(got.res ?? got.error),
  );
  check(
    `${name}: nada muda no usuário (histórico, XP, nível, partidas, vitórias, pontos, sequência, conquistas)`,
    same(before, got.after),
    `antes=${short(before)} depois=${short(got.after)}`,
  );
}

// Fim natural / histórico: idêntico à versão anterior da função.
async function expectLikeBefore(name, uid, room) {
  const st = await roomState(room.id);
  check(`${name}: encerrada sem motivo de limpeza`, st.status === "finished" && st.reason === null, short(st));
  const before = await snap(db, uid);
  const ref = await callAs(db, uid, "__p2_ref_record_match_result", room.code, { commit: false });
  const got = await callAs(db, uid, "record_match_result", room.code);
  check(
    `${name}: XP, nível, histórico, estatísticas e conquistas = versão anterior`,
    got.res?.ok === true && !got.res?.deduped && got.res?.xp_gained > 0 && same(ref.res, got.res) && same(ref.after, got.after),
    `anterior=${short(ref.res ?? ref.error)} nova=${short(got.res ?? got.error)}`,
  );
  check(`${name}: histórico +1`, got.after?.history === before.history + 1, `${before.history} → ${got.after?.history}`);
  return got;
}

const cleanup = async () => (await row(`SELECT public.cleanup_zombie_rooms() AS r`)).r;
const prev = previousDefinition("record_match_result");

try {
  // -------------------------------------------------------------------------
  console.log(`\n— Referência: record_match_result anterior (${prev?.file})`);
  await db.query(
    prev.sql.replace(/FUNCTION\s+public\.record_match_result\s*\(/i, "FUNCTION public.__p2_ref_record_match_result("),
  );
  await db.query(`REVOKE ALL ON FUNCTION public.__p2_ref_record_match_result(text) FROM PUBLIC, anon, authenticated`);
  check("referência é a versão anterior (sem a trava do P2)", !/match_not_rewardable/.test(prev.sql), prev.file);

  // -------------------------------------------------------------------------
  console.log("\n— A–D. Salas encerradas pela limpeza (cleanup_zombie_rooms de verdade)");
  const uA = await mkUser();
  const uB = await mkUser();
  const uC = await mkUser();
  const uD = await mkUser();
  const uReset = await mkUser();
  const uRace = await mkUser();
  // A. fase parada há 40 min (regra v2 de fase abandonada)
  const A = await mkRoom(uA, { status: "voting", createdMin: 120, phaseMin: 40, humanMin: 45, botMin: 41 });
  // B. R4: rodada 5, fase recém-renovada pelo tick, bot agindo agora, humano parado há 40 min
  const B = await mkRoom(uB, { status: "voting", round: 5, createdMin: 60, phaseMin: 0, humanMin: 40, botMin: 0 });
  // C. lobby abandonado há 2 h (ninguém jogou: todos com 0 — o humano "venceria")
  const C = await mkRoom(uC, { status: "lobby", round: 0, createdMin: 120, humanMin: 120, score: 0, botScore: 0, game: false });
  // D. sem humano conectado (saiu) numa sala em escolha
  const D = await mkRoom(uD, { status: "choosing", round: 2, createdMin: 5, phaseMin: 1, humanMin: 3, botMin: 1, connected: false });
  // revanche depois da limpeza / corrida em sala da limpeza (fase parada)
  const R = await mkRoom(uReset, { status: "writing", createdMin: 90, phaseMin: 35, humanMin: 50, botMin: 36 });
  const X = await mkRoom(uRace, { status: "reveal", createdMin: 90, phaseMin: 35, humanMin: 50, botMin: 36 });
  const res = await cleanup();
  console.log(`   cleanup: ${short(res)}`);
  await expectNotRewardable("A · fase parada (v2)", uA, A, "cleanup_stale");
  await expectNotRewardable("B · R4 sem ação humana", uB, B, "cleanup_idle");
  await expectNotRewardable("C · lobby abandonado", uC, C, "cleanup_lobby");
  await expectNotRewardable("D · sem humano conectado", uD, D, "cleanup_empty");

  // -------------------------------------------------------------------------
  console.log("\n— E–H. Fim natural e sala histórica: idênticos à versão anterior");
  // E. alvo de pontos atingido na revelação (finish_reveal)
  const uE = await mkUser();
  const E = await mkRoom(uE, { status: "reveal", score: 15, botScore: 4 });
  const fr = (await row(`SELECT public.finish_reveal($1) AS r`, [E.id])).r;
  check("E · finish_reveal encerra pela pontuação", fr?.status === "finished", short(fr));
  await expectLikeBefore("E · fim natural por pontos", uE, E);

  // F. limite de rodadas no placar (advance_scoreboard_to_next_round_or_finished)
  const uF = await mkUser();
  const F = await mkRoom(uF, { status: "scoreboard", win: "rounds", target: 3, round: 3, score: 2, botScore: 5 });
  const adv = (await row(`SELECT public.advance_scoreboard_to_next_round_or_finished($1, true) AS r`, [F.id])).r;
  check("F · placar encerra pelo limite de rodadas", adv?.action === "finished", short(adv));
  await expectLikeBefore("F · fim natural por rodadas", uF, F);

  // G. dedup: a segunda chamada não soma nada
  {
    const before = await snap(db, uE);
    const again = await callAs(db, uE, "record_match_result", E.code);
    check(
      "G · dedup: 2ª chamada devolve deduped e xp 0, nada muda",
      again.res?.ok === true && again.res?.deduped === true && again.res?.xp_gained === 0 && same(before, again.after),
      short(again.res),
    );
  }

  // H. sala histórica (encerrada antes do motivo existir): sem marca = paga como sempre
  const uH = await mkUser();
  const H = await mkRoom(uH, { status: "scoreboard", score: 9, botScore: 9 });
  await db.query(`UPDATE public.rooms SET status = 'finished', round_phase_ends_at = NULL WHERE id = $1`, [H.id]);
  await expectLikeBefore("H · sala histórica sem motivo", uH, H);
  {
    const again = await callAs(db, uH, "record_match_result", H.code);
    check(
      "H · histórico já gravado continua lá (dedup, nada removido)",
      again.res?.deduped === true && again.after?.history === 1,
      short(again.res),
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n— Revanche: reset do host depois da limpeza");
  await expectNotRewardable("R · fase parada", uReset, R, "cleanup_stale");
  await db.query(`SELECT public.reset_room($1)`, [R.id]);
  const afterReset = await roomState(R.id);
  check("reset limpa o motivo (lobby sem marca)", afterReset.status === "lobby" && afterReset.reason === null, short(afterReset));
  const lobbyCall = await callAs(db, uReset, "record_match_result", R.code);
  check(
    "sala resetada: pódio não paga (partida não terminou)",
    lobbyCall.res?.ok === false && lobbyCall.res?.reason === "match_not_finished",
    short(lobbyCall.res ?? lobbyCall.error),
  );
  // revanche jogada de verdade até o alvo → paga normal, igual à versão anterior
  await db.query(`UPDATE public.rooms SET status = 'reveal', current_round = 1, phase_started_at = now() WHERE id = $1`, [R.id]);
  await db.query(`UPDATE public.players SET score = CASE WHEN is_bot THEN 4 ELSE 15 END WHERE room_id = $1`, [R.id]);
  await addGame(R, 1, 0, 0, 0);
  await row(`SELECT public.finish_reveal($1) AS r`, [R.id]);
  await expectLikeBefore("R · revanche natural depois da limpeza", uReset, R);

  // -------------------------------------------------------------------------
  console.log("\n— I. Segurança do motivo");
  const priv = await row(
    `SELECT has_table_privilege('anon', 'public.rooms', 'UPDATE') AS anon_u,
            has_table_privilege('authenticated', 'public.rooms', 'UPDATE') AS auth_u`,
  );
  check("anon/authenticated sem UPDATE em rooms", !priv.anon_u && !priv.auth_u, short(priv));
  // O papel é conferido ANTES (current_user): um SET ROLE recusado também
  // daria 42501 e o teste passaria pelo motivo errado.
  const asRole = async (role, sql, p = []) => {
    await db.query("BEGIN");
    let err = null;
    let who = null;
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      who = (await db.query(`SELECT current_user AS u`)).rows[0].u;
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uA, role })]);
      await db.query(sql, p);
    } catch (e) {
      err = e;
    }
    await db.query("ROLLBACK");
    return { who, err };
  };
  for (const role of ["anon", "authenticated"]) {
    const { who, err } = await asRole(role, `UPDATE public.rooms SET finish_reason = NULL WHERE id = $1`, [A.id]);
    check(
      `${role} não apaga o motivo direto na tabela (42501 em rooms)`,
      who === role && err?.code === "42501" && /rooms/.test(err.message),
      `papel=${who} ${err ? `${err.code} ${err.message}` : "UPDATE passou"}`,
    );
  }
  {
    const { who, err } = await asRole("authenticated", `SELECT public.cleanup_zombie_rooms()`);
    check(
      "jogador não roda a limpeza (42501)",
      who === "authenticated" && err?.code === "42501" && /cleanup_zombie_rooms/.test(err.message),
      `papel=${who} ${err ? `${err.code} ${err.message}` : "rodou"}`,
    );
  }
  const bad = async (sql, p) => {
    await db.query("BEGIN");
    try {
      await db.query(sql, p);
      await db.query("ROLLBACK");
      return null;
    } catch (e) {
      await db.query("ROLLBACK");
      return e.code;
    }
  };
  check(
    "CHECK: motivo só em sala finished",
    (await bad(`UPDATE public.rooms SET finish_reason = 'cleanup_idle' WHERE id = $1`, [R.id])) === "23514",
  );
  check(
    "CHECK: só motivos da limpeza (valor inventado recusado)",
    (await bad(`UPDATE public.rooms SET finish_reason = 'natural' WHERE id = $1`, [A.id])) === "23514",
  );
  if (SUPA_URL && ANON) {
    const { createClient } = await import("@supabase/supabase-js");
    const anonC = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
    const a = await anonC.from("rooms").update({ finish_reason: null }).eq("id", A.id).select();
    const authC = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
    const s = await authC.auth.signInAnonymously();
    if (s.data?.user?.id) users.push(s.data.user.id);
    const b = await authC.from("rooms").update({ finish_reason: null }).eq("id", A.id).select();
    const still = await roomState(A.id);
    check(
      "REST (anônimo e com sessão) não apaga o motivo",
      !!a.error && !!b.error && still.reason === "cleanup_stale",
      `anon=${a.error?.code} sessão=${b.error?.code} motivo=${still.reason}`,
    );
  } else {
    console.log("   (REST pulado: sem SUPA_URL/ANON — no CI roda)");
  }

  // -------------------------------------------------------------------------
  console.log("\n— J. Concorrência: duas chamadas simultâneas (advisory lock)");
  {
    const uJ = await mkUser();
    const J = await mkRoom(uJ, { status: "reveal", score: 15, botScore: 1 });
    await row(`SELECT public.finish_reveal($1) AS r`, [J.id]);
    const c1 = new pg.Client({ connectionString: DB_URL, ssl });
    const c2 = new pg.Client({ connectionString: DB_URL, ssl });
    await c1.connect();
    await c2.connect();
    const claims = JSON.stringify({ sub: uJ, role: "authenticated" });
    try {
      await c1.query("BEGIN");
      await c1.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
      const r1 = (await c1.query(`SELECT public.record_match_result($1) AS r`, [J.code])).rows[0].r;
      await c2.query("BEGIN");
      await c2.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
      let settled = false;
      const p2 = c2.query(`SELECT public.record_match_result($1) AS r`, [J.code]).then((x) => {
        settled = true;
        return x.rows[0].r;
      });
      await new Promise((ok) => setTimeout(ok, 400));
      const waited = !settled;
      await c1.query("COMMIT");
      const r2 = await p2;
      await c2.query("COMMIT");
      const after = await snap(db, uJ);
      check(
        "J · partida natural: a 2ª espera a 1ª e sai deduped; XP e histórico uma única vez",
        waited && r1?.ok === true && r1?.xp_gained > 0 && r2?.deduped === true && after.history === 1 && after.stats?.xp === r1.xp_gained,
        `esperou=${waited} r1=${short(r1)} r2=${short(r2)} hist=${after.history}`,
      );
    } finally {
      await c1.end();
      await c2.end();
    }
    const cA = new pg.Client({ connectionString: DB_URL, ssl });
    const cB = new pg.Client({ connectionString: DB_URL, ssl });
    await cA.connect();
    await cB.connect();
    try {
      const [ra, rb] = await Promise.all([
        callAs(cA, uRace, "record_match_result", X.code),
        callAs(cB, uRace, "record_match_result", X.code),
      ]);
      const after = await snap(db, uRace);
      check(
        "J · sala da limpeza: duas chamadas simultâneas, nenhuma paga",
        ra.res?.reason === "match_not_rewardable" && rb.res?.reason === "match_not_rewardable" && after.history === 0 && after.stats === null,
        `a=${short(ra.res ?? ra.error)} b=${short(rb.res ?? rb.error)} hist=${after.history}`,
      );
    } finally {
      await cA.end();
      await cB.end();
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n— Lista FECHADA de caminhos para 'finished' (caminho novo sem classificação reprova)");
  {
    const fns = (
      await db.query(
        `SELECT p.proname AS fn,
                (SELECT count(*) FROM regexp_matches(p.prosrc, 'status\\s*=\\s*''finished''', 'g'))::int AS sets,
                (SELECT count(*) FROM regexp_matches(p.prosrc, 'finish_reason\\s*=\\s*''cleanup_', 'g'))::int AS marks
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname <> '__p2_ref_record_match_result'
            AND (p.prosrc ~ 'status\\s*=\\s*''finished''' OR p.prosrc ~ 'THEN\\s+''finished''')
          ORDER BY 1`,
      )
    ).rows;
    const NATURAL = ["advance_scoreboard_to_next_round_or_finished", "finish_reveal"];
    const OPERATIONAL = ["cleanup_zombie_rooms"];
    const names = fns.map((f) => f.fn);
    check(
      "todo caminho para 'finished' está classificado (natural: finish_reveal, advance_scoreboard…; limpeza: cleanup_zombie_rooms)",
      same(names, [...NATURAL, ...OPERATIONAL].sort()),
      names.join(", "),
    );
    const cz = fns.find((f) => f.fn === "cleanup_zombie_rooms");
    check("limpeza grava o motivo em TODA regra que encerra", cz?.sets > 0 && cz?.marks === cz?.sets, `encerra=${cz?.sets} marca=${cz?.marks}`);
    check(
      "fim natural não grava motivo",
      fns.filter((f) => NATURAL.includes(f.fn)).every((f) => f.marks === 0),
      short(fns.filter((f) => NATURAL.includes(f.fn))),
    );
  }
} finally {
  await db.query(`DELETE FROM public.rooms WHERE id = ANY($1)`, [rooms]);
  if (users.length) {
    await db.query(`DELETE FROM public.user_achievements WHERE user_id = ANY($1)`, [users]);
    await db.query(`DELETE FROM public.match_history WHERE user_id = ANY($1)`, [users]);
    await db.query(`DELETE FROM public.user_stats WHERE user_id = ANY($1)`, [users]);
    await db.query(`DELETE FROM auth.users WHERE id = ANY($1)`, [users]);
  }
  await db.query(`DROP FUNCTION IF EXISTS public.__p2_ref_record_match_result(text)`);
  await db.end();
}
console.log(fails ? `\n${fails}/${total} FALHAS` : `\nP2 XP (LIMPEZA SEM RECOMPENSA) OK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
