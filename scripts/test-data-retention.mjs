// Retenção de dados (Rodada 2B, 2026-10-27) e nome exibido sem o e-mail.
//
// Prova, no banco do CI, que run_data_retention():
//   - apaga a sala ENCERRADA há > 30 dias (com tudo o que é dela) e mantém a
//     encerrada há < 30 dias, a sala viva antiga e a que acabou de ter
//     revanche; a denúncia da sala apagada sobrevive com o retrato;
//   - apaga o convidado inativo há > 30 dias (perfil, stats, histórico,
//     palpites, conquistas) e NUNCA a conta real, o convidado com sinal de uso
//     recente (sessão, refresh, entrada em sala) nem o convidado sentado numa
//     sala viva;
//   - apaga a denúncia resolvida/descartada há > 180 dias e mantém a recente,
//     a pendente antiga e a fechada sem data; banimentos ficam intocados;
//   - é idempotente (2ª execução não apaga nada) e deixa heartbeat/evento.
// E que handle_new_user nunca usa o trecho do e-mail nem o nome do Google.
// Envs: DB_URL.
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
const n = async (sql, p = []) => Number((await row(sql, p)).n);
const tag = Math.random().toString(36).slice(2, 7);
let seq = 0;
const ago = (days) => `now() - make_interval(days => ${days})`;

// ---------------------------------------------------------------- salas
// Sala com jogo completo; `finishedDays` = null → sala viva no `status`.
async function mkRoom({ status = "finished", finishedDays = 40, ageDays = 45 } = {}) {
  seq++;
  const code = `RT${tag}${seq}`;
  const host = `rt_h_${tag}_${seq}`;
  const r = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, created_at, phase_started_at)
     VALUES ($1, $2, 'lobby', 1, ${ago(ageDays)}, ${ago(ageDays)}) RETURNING id`,
    [code, host],
  );
  const id = r.id;
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, joined_at)
     VALUES ($1, $2, 'Host', 'h', '#000', false, ${ago(ageDays)})`,
    [host, id],
  );
  const def = await row(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, created_at)
     VALUES ($1, 1, $2, 'blefe antigo', false, ${ago(ageDays)}) RETURNING id`,
    [id, host],
  );
  await db.query(
    `INSERT INTO public.votes (room_id, round, voter_id, definition_id, created_at)
     VALUES ($1, 1, $2, $3, ${ago(ageDays)})`,
    [id, `rt_v_${tag}_${seq}`, def.id],
  );
  await db.query(
    `INSERT INTO public.reactions (room_id, player_id, emoji, created_at) VALUES ($1, $2, '😂', ${ago(ageDays)})`,
    [id, host],
  );
  await db.query(
    `INSERT INTO public.rounds (room_id, round, coordinator_id, scored_at) VALUES ($1, 1, $2, ${ago(ageDays)})`,
    [id, host],
  );
  await db.query(
    `INSERT INTO public.room_messages (room_id, player_id, text, created_at) VALUES ($1, $2, 'oi', ${ago(ageDays)})`,
    [id, host],
  );
  await db.query(`INSERT INTO public.ai_served_defs (room_id, round, norm_text) VALUES ($1, 1, 'x')`, [id]);
  await db.query(
    `INSERT INTO public.round_extensions (room_id, round, player_id, attempt, applied_at)
     VALUES ($1, 1, $2, 1, ${ago(ageDays)})`,
    [id, host],
  );
  await db.query(
    `INSERT INTO public.room_words (room_id, word, meaning, created_by, created_at)
     VALUES ($1, 'w', 'm', $2, ${ago(ageDays)})`,
    [id, host],
  );
  await db.query(
    `INSERT INTO public.room_presence (player_id, room_id, active_at) VALUES ($1, $2, ${ago(ageDays)})`,
    [host, id],
  );
  if (status === "finished") {
    await db.query(`UPDATE public.rooms SET status = 'finished' WHERE id = $1`, [id]);
    await db.query(`UPDATE public.rooms SET finished_at = ${ago(finishedDays)} WHERE id = $1`, [id]);
  } else if (status !== "lobby") {
    await db.query(`UPDATE public.rooms SET status = $2 WHERE id = $1`, [id, status]);
  }
  return { id, code, host, defId: def.id };
}

const roomLeft = async (id) => {
  const c = await row(
    `SELECT
       (SELECT count(*) FROM public.rooms WHERE id = $1)::int AS rooms,
       (SELECT count(*) FROM public.players WHERE room_id = $1)::int AS players,
       (SELECT count(*) FROM public.definitions WHERE room_id = $1)::int AS defs,
       (SELECT count(*) FROM public.votes WHERE room_id = $1)::int AS votes,
       (SELECT count(*) FROM public.reactions WHERE room_id = $1)::int AS reactions,
       (SELECT count(*) FROM public.rounds WHERE room_id = $1)::int AS rounds,
       (SELECT count(*) FROM public.room_messages WHERE room_id = $1)::int AS msgs,
       (SELECT count(*) FROM public.ai_served_defs WHERE room_id = $1)::int AS ai,
       (SELECT count(*) FROM public.round_extensions WHERE room_id = $1)::int AS ext,
       (SELECT count(*) FROM public.room_words WHERE room_id = $1)::int AS words,
       (SELECT count(*) FROM public.room_presence WHERE room_id = $1)::int AS presence`,
    [id],
  );
  return Object.values(c).reduce((a, b) => a + b, 0);
};

// ---------------------------------------------------------------- contas
const users = [];
async function mkUser({ anon = true, ageDays = 40, email = null, meta = {} } = {}) {
  const id = (await row(`SELECT gen_random_uuid() AS id`)).id;
  await db.query(
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, is_anonymous,
                             raw_user_meta_data, created_at, updated_at, last_sign_in_at)
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', $3,
             $4::jsonb, ${ago(ageDays)}, ${ago(ageDays)}, ${ago(ageDays)})`,
    [id, email, anon, JSON.stringify(meta)],
  );
  // handle_new_user criou perfil + stats agora: envelhece junto com a conta.
  await db.query(
    `UPDATE public.profiles SET created_at = ${ago(ageDays)}, updated_at = ${ago(ageDays)} WHERE user_id = $1`,
    [id],
  );
  await db.query(`UPDATE public.user_stats SET updated_at = ${ago(ageDays)} WHERE user_id = $1`, [id]);
  await db.query(
    `INSERT INTO public.match_history (user_id, room_code, final_score, position, players_count, played_at)
     VALUES ($1, 'X', 1, 1, 4, ${ago(ageDays)})`,
    [id],
  );
  await db.query(
    `INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, created_at)
     VALUES ($1, (${ago(ageDays)})::date, date_trunc('hour', ${ago(ageDays)}), 'palpite', ${ago(ageDays)})`,
    [id],
  );
  await db.query(
    `INSERT INTO public.user_achievements (user_id, achievement_code, unlocked_at)
     VALUES ($1, 'first_win', ${ago(ageDays)})`,
    [id],
  );
  users.push(id);
  return id;
}
const userLeft = (id) =>
  n(
    `SELECT (SELECT count(*) FROM auth.users WHERE id = $1)
          + (SELECT count(*) FROM public.profiles WHERE user_id = $1)
          + (SELECT count(*) FROM public.user_stats WHERE user_id = $1)
          + (SELECT count(*) FROM public.match_history WHERE user_id = $1)
          + (SELECT count(*) FROM public.daily_attempts WHERE user_id = $1)
          + (SELECT count(*) FROM public.user_achievements WHERE user_id = $1) AS n`,
    [id],
  );

// ---------------------------------------------------------------- denúncias
async function mkReport({ status, resolvedDays, createdDays = 400, roomId = null, playerId = "rt_off" }) {
  const r = await row(
    `INSERT INTO public.reports (definition_text, room_id, room_code, round, offender_player_id,
                                 offender_nickname, reporter_user_id, status, resolved_at, created_at)
     VALUES ('texto denunciado', $1, 'RT', 1, $2, 'Ofensor', gen_random_uuid(), $3,
             ${resolvedDays == null ? "NULL" : ago(resolvedDays)}, ${ago(createdDays)})
     RETURNING id`,
    [roomId, playerId, status],
  );
  return r.id;
}
const exists = async (table, id) => (await n(`SELECT count(*) AS n FROM public.${table} WHERE id = $1`, [id])) > 0;

// Tudo numa transação desfeita no fim: o tick do CI (pg_cron, 1 min) e o
// próprio job de retenção não enxergam estas linhas (a limpeza de salas-zumbi
// encerraria o lobby e a sala "viva" antigos no meio do teste) e nada sobra
// no banco das outras suítes. now() fica fixo no início — os prazos abaixo
// são relativos a ele.
await db.query("BEGIN");
try {
  // ======================= trigger finished_at =======================
  const t = await mkRoom({ status: "lobby", ageDays: 1 });
  await db.query(`UPDATE public.rooms SET status = 'finished' WHERE id = $1`, [t.id]);
  const f1 = await row(`SELECT finished_at, now() - finished_at < interval '1 minute' AS fresh FROM public.rooms WHERE id = $1`, [t.id]);
  check("trigger: virar 'finished' grava finished_at = agora", f1.fresh === true, String(f1.finished_at));
  await db.query(`UPDATE public.rooms SET status = 'lobby' WHERE id = $1`, [t.id]);
  const f2 = await row(`SELECT finished_at FROM public.rooms WHERE id = $1`, [t.id]);
  check("trigger: revanche (volta ao lobby) zera finished_at", f2.finished_at === null);
  let bad = null;
  await db.query("SAVEPOINT chk");
  try {
    await db.query(`UPDATE public.rooms SET finished_at = now() WHERE id = $1`, [t.id]);
  } catch (e) {
    bad = e.message;
  }
  await db.query("ROLLBACK TO SAVEPOINT chk");
  check("CHECK: sala viva não aceita finished_at", /rooms_finished_at_check/.test(bad ?? ""), bad ?? "aceitou");

  // ======================= cenário =======================
  const roomNew = await mkRoom({ finishedDays: 10, ageDays: 12 }); // A
  const roomOld = await mkRoom({ finishedDays: 31, ageDays: 35 }); // B
  const room29 = await mkRoom({ finishedDays: 29, ageDays: 29 }); // A (fronteira)
  const roomLive = await mkRoom({ status: "writing", ageDays: 90 }); // C (viva antiga)
  const roomLobby = await mkRoom({ status: "lobby", ageDays: 90 }); // C (lobby antigo)
  // encerrada há 40 dias, mas um humano reagiu ontem (atividade real recente)
  const roomTouched = await mkRoom({ finishedDays: 40, ageDays: 45 });
  await db.query(
    `INSERT INTO public.reactions (room_id, player_id, emoji, created_at) VALUES ($1, $2, '👏', now() - interval '1 day')`,
    [roomTouched.id, roomTouched.host],
  );
  // revanche de sala antiga: estava 'finished' há 40 dias e voltou ao lobby
  const roomRematch = await mkRoom({ finishedDays: 40, ageDays: 45 });
  await db.query(`UPDATE public.rooms SET status = 'lobby' WHERE id = $1`, [roomRematch.id]);

  const repOfOldRoom = await mkReport({ status: "pending", resolvedDays: null, createdDays: 33, roomId: roomOld.id, playerId: roomOld.host });
  const repResolvedNew = await mkReport({ status: "resolved", resolvedDays: 100 }); // D
  const repPendingOld = await mkReport({ status: "pending", resolvedDays: null, createdDays: 900 }); // E
  const repResolvedOld = await mkReport({ status: "resolved", resolvedDays: 181 }); // F
  const rep179 = await mkReport({ status: "dismissed", resolvedDays: 179 }); // D (fronteira)
  const repDismissedOld = await mkReport({ status: "dismissed", resolvedDays: 200 }); // F
  const repNoDate = await mkReport({ status: "resolved", resolvedDays: null, createdDays: 900 });

  const banTemp = (await row(
    `INSERT INTO public.banned_players (player_id, reason, banned_by, banned_at, expires_at)
     VALUES ($1, 'temp', gen_random_uuid(), ${ago(300)}, now() + interval '5 days') RETURNING id`, [`rt_bt_${tag}`])).id;
  const banPerm = (await row(
    `INSERT INTO public.banned_players (player_id, reason, banned_by, banned_at, expires_at)
     VALUES ($1, 'perma', gen_random_uuid(), ${ago(900)}, NULL) RETURNING id`, [`rt_bp_${tag}`])).id;
  const banExpired = (await row(
    `INSERT INTO public.banned_players (player_id, reason, banned_by, banned_at, expires_at)
     VALUES ($1, 'velho', gen_random_uuid(), ${ago(900)}, ${ago(800)}) RETURNING id`, [`rt_be_${tag}`])).id;

  const realOld = await mkUser({ anon: false, ageDays: 400, email: `rt_${tag}_real@test.local` }); // H
  // convertido: era convidado e ligou e-mail (is_anonymous false)
  const converted = await mkUser({ anon: false, ageDays: 400, email: `rt_${tag}_conv@test.local` });
  // marcador anômalo: is_anonymous true MAS com e-mail → não é convidado puro
  const anonWithEmail = await mkUser({ anon: true, ageDays: 400, email: `rt_${tag}_odd@test.local` });
  const anonOld = await mkUser({ anon: true, ageDays: 40 }); // J
  const anonNew = await mkUser({ anon: true, ageDays: 5 }); // I
  const anon29 = await mkUser({ anon: true, ageDays: 29 }); // I (fronteira)
  const anonSession = await mkUser({ anon: true, ageDays: 60 }); // I: renovou a sessão ontem
  const sess = (await row(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, ${ago(60)}, now() - interval '1 day') RETURNING id`, [anonSession])).id;
  const anonRefresh = await mkUser({ anon: true, ageDays: 60 }); // I: refresh do token ontem
  const sess2 = (await row(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, ${ago(60)}, ${ago(60)}) RETURNING id`, [anonRefresh])).id;
  await db.query(
    `INSERT INTO auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
     VALUES ('00000000-0000-0000-0000-000000000000', $1, $2, false, now() - interval '1 day', now() - interval '1 day', $3)`,
    [`rt_tok_${tag}`, anonRefresh, sess2],
  );
  const anonPlayed = await mkUser({ anon: true, ageDays: 60 }); // I: entrou numa sala ontem
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id, joined_at)
     VALUES ($1, $2, 'Conv', 'c', '#000', $3, now() - interval '1 day')`,
    [`rt_pl_${tag}`, roomNew.id, anonPlayed],
  );
  const anonSeated = await mkUser({ anon: true, ageDays: 60 }); // sentado numa sala viva
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id, joined_at)
     VALUES ($1, $2, 'Sentado', 's', '#000', $3, ${ago(60)})`,
    [`rt_ps_${tag}`, roomLive.id, anonSeated],
  );
  const anonAdmin = await mkUser({ anon: true, ageDays: 60 });
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [anonAdmin]);
  // denúncia feita por um convidado que vai expirar: a denúncia fica
  const repByAnon = (await row(
    `INSERT INTO public.reports (definition_text, offender_player_id, reporter_user_id, status, created_at)
     VALUES ('denúncia do convidado', 'rt_x', $1, 'pending', ${ago(40)}) RETURNING id`, [anonOld])).id;

  // ======================= 1ª execução =======================
  const run1 = (await row(`SELECT public.run_data_retention() AS r`)).r;
  console.log("   run1:", JSON.stringify(run1));
  check("execução sem erro", run1.errors === 0, run1.first_error ?? "");

  check("A: sala encerrada há 10 dias fica", (await roomLeft(roomNew.id)) > 0);
  check("A: sala encerrada há 29 dias, sem uso desde então, fica", (await roomLeft(room29.id)) > 0);
  check("B: sala encerrada há 31 dias sai inteira (rooms + 10 tabelas da sala)", (await roomLeft(roomOld.id)) === 0, `sobrou ${await roomLeft(roomOld.id)}`);
  check("C: sala VIVA (writing) de 90 dias fica", (await roomLeft(roomLive.id)) > 0);
  check("C: lobby de 90 dias fica (nunca apaga o que não está finished)", (await roomLeft(roomLobby.id)) > 0);
  check("sala encerrada com atividade humana recente fica", (await roomLeft(roomTouched.id)) > 0);
  check("revanche de sala antiga fica", (await roomLeft(roomRematch.id)) > 0);
  const snap = await row(`SELECT room_id, room_code, offender_player_id, offender_nickname, definition_text FROM public.reports WHERE id = $1`, [repOfOldRoom]);
  check(
    "L: denúncia da sala apagada sobrevive com o retrato",
    snap && snap.room_id === roomOld.id && snap.offender_player_id === roomOld.host && snap.definition_text === "texto denunciado",
    JSON.stringify(snap),
  );

  check("D: resolvida há 100 dias fica", await exists("reports", repResolvedNew));
  check("D: descartada há 179 dias fica", await exists("reports", rep179));
  check("E: pendente de 900 dias fica (pendente não expira por idade)", await exists("reports", repPendingOld));
  check("F: resolvida há 181 dias sai", !(await exists("reports", repResolvedOld)));
  check("F: descartada há 200 dias sai", !(await exists("reports", repDismissedOld)));
  check("fechada SEM resolved_at fica (e é contada)", (await exists("reports", repNoDate)) && run1.reports_closed_without_date >= 1);
  check("denúncia feita por convidado expirado fica", await exists("reports", repByAnon));

  check("G: ban temporário vigente fica", await exists("banned_players", banTemp));
  check("G: ban permanente de 900 dias fica", await exists("banned_players", banPerm));
  check("ban expirado também não é tocado (fora do escopo)", await exists("banned_players", banExpired));

  check("H: conta real inativa há 400 dias NUNCA sai", (await userLeft(realOld)) === 6);
  check("H: convidado convertido em conta NUNCA sai", (await userLeft(converted)) === 6);
  check("is_anonymous com e-mail (anômalo) não sai", (await userLeft(anonWithEmail)) === 6);
  check("J: convidado inativo há 40 dias sai com perfil/stats/histórico/palpites/conquistas", (await userLeft(anonOld)) === 0, `sobrou ${await userLeft(anonOld)}`);
  check("I: convidado de 5 dias fica", (await userLeft(anonNew)) === 6);
  check("I: convidado sem uso há 29 dias fica", (await userLeft(anon29)) === 6);
  check("I: convidado que renovou a sessão ontem fica", (await userLeft(anonSession)) === 6);
  check("I: convidado com refresh de token ontem fica", (await userLeft(anonRefresh)) === 6);
  check("I: convidado que entrou numa sala ontem fica", (await userLeft(anonPlayed)) === 6);
  check("convidado sentado numa sala viva fica", (await userLeft(anonSeated)) === 6);
  check("convidado com papel (admin) fica", (await userLeft(anonAdmin)) === 6);
  check("sessão do convidado ativo intacta", (await n(`SELECT count(*) AS n FROM auth.sessions WHERE id = $1`, [sess])) === 1);

  const hb = await row(`SELECT at, payload FROM public.ops_heartbeat WHERE job = 'data_retention'`);
  check("heartbeat 'data_retention' gravado", hb && Date.now() - new Date(hb.at).getTime() < 120_000, JSON.stringify(hb?.payload));
  const ev = await row(
    `SELECT payload FROM public.ops_events WHERE kind = 'data_retention' ORDER BY at DESC LIMIT 1`,
  );
  check("evento 'data_retention' com as contagens", ev && ev.payload.rooms_deleted >= 1 && ev.payload.anon_deleted >= 1 && ev.payload.reports_deleted >= 2, JSON.stringify(ev?.payload));

  // ======================= K: idempotência =======================
  const run2 = (await row(`SELECT public.run_data_retention() AS r`)).r;
  console.log("   run2:", JSON.stringify(run2));
  check(
    "K: 2ª execução não apaga nada e não erra",
    run2.errors === 0 && run2.rooms_deleted === 0 && run2.anon_deleted === 0 && run2.reports_deleted === 0,
  );
  check("K: o que ficou continua lá", (await roomLeft(roomNew.id)) > 0 && (await userLeft(realOld)) === 6 && (await exists("reports", repPendingOld)));

  // limite por execução
  const lim = (await row(`SELECT public.retention_purge_rooms(0) AS r`)).r;
  check("limite 0 não apaga nada", lim.deleted === 0);

  // cron: um job só, de hora em hora
  const jobs = await row(`SELECT count(*)::int AS n, max(schedule) AS s FROM cron.job WHERE jobname = 'verbete-data-retention'`);
  check("cron 'verbete-data-retention' agendado uma vez, de hora em hora", jobs.n === 1 && jobs.s === "17 * * * *", JSON.stringify(jobs));

  // funções internas fechadas para os clients
  const open = await n(
    `SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public'
        AND p.proname IN ('run_data_retention', 'retention_purge_rooms', 'retention_purge_anon_users',
                          'retention_purge_reports', 'retention_anon_candidates', 'rooms_track_finished_at')
        AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
  );
  check("nenhuma função de retenção executável por anon/authenticated", open === 0, `${open} abertas`);

  // ======================= M/N/O: nome exibido =======================
  async function nameFor(email, meta) {
    await db.query("SAVEPOINT nm");
    try {
      const id = (await row(`SELECT gen_random_uuid() AS id`)).id;
      await db.query(
        `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
         VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', $3::jsonb, now(), now())`,
        [id, email, JSON.stringify(meta)],
      );
      return (await row(`SELECT display_name FROM public.profiles WHERE user_id = $1`, [id])).display_name;
    } finally {
      await db.query("ROLLBACK TO SAVEPOINT nm");
    }
  }
  const e = `maria.silva.${tag}@exemplo.com`;
  const pre = e.split("@")[0];
  check("M: cadastro sem nome → 'Jogador'", (await nameFor(e, {})) === "Jogador");
  check("M: nome só com espaços → 'Jogador'", (await nameFor(e, { display_name: "   " })) === "Jogador");
  check("N: cliente antigo manda o trecho do e-mail → 'Jogador'", (await nameFor(e, { display_name: pre })) === "Jogador");
  check("N: trecho em MAIÚSCULAS → 'Jogador'", (await nameFor(e, { display_name: pre.toUpperCase() })) === "Jogador");
  check("N: o e-mail inteiro → 'Jogador'", (await nameFor(e, { display_name: e })) === "Jogador");
  check("N: e-mail com + no usuário → 'Jogador'", (await nameFor(`ana+jogo.${tag}@x.io`, { display_name: `ana+jogo.${tag}` })) === "Jogador");
  check("N: nome com @ → 'Jogador'", (await nameFor(e, { display_name: "fulano@" })) === "Jogador");
  check("nome escolhido é mantido", (await nameFor(e, { display_name: "  Mestre Verbete " })) === "Mestre Verbete");
  check("nome longo cortado em 24", (await nameFor(e, { display_name: "x".repeat(40) })) === "x".repeat(24));
  check(
    "O: Google (name/full_name, sem display_name) → 'Jogador'",
    (await nameFor(`joao.${tag}@gmail.com`, { name: "João da Silva", full_name: "João da Silva", email: `joao.${tag}@gmail.com` })) === "Jogador",
  );
  check("convidado (sem e-mail) → 'Jogador'", (await nameFor(null, {})) === "Jogador");
} catch (e) {
  check("suíte rodou até o fim", false, e.message);
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}

console.log(`\n${total - fails}/${total} verificações OK`);
process.exit(fails ? 1 : 0);
