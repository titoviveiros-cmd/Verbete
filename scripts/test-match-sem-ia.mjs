// Multiplayer sem IA (08/11/2026): PARTIDA COMPLETA com app_config.ai_mode =
// 'suspenso' — lobby → 2 rodadas (escolha → escrita → votação → revelação →
// placar) → finished, pelo caminho do cliente (REST com sessão anônima) e
// pelos avanços do motor (SQL interno, como o cron).
// Prova que nenhuma transição depende do juiz 🧠/da IA:
//   * revelação → placar depende só de rounds.scored_at (não de judged_at);
//   * pontuação = regra congelada (+3 verdade, +1 por enganado, +2 coordenador
//     se ninguém acerta), sem bônus 🧠 e sem near_truth;
//   * get_room_reveal não traz near_truth_ids; nenhum evento judge_ai_*/bot_ai_*;
//   * a sala termina (finished) no alvo de rodadas.
// O caminho do juiz suspenso pela cadeia pg_net → edge é coberto em
// test-edges-e2e.mjs ("contenção da IA"); aqui as edges NÃO são servidas, que
// é o pior caso (sem juiz nenhum respondendo).
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
const { SUPA_URL, ANON, DB_URL } = process.env;

const client = createClient(SUPA_URL, ANON, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const { error: signErr } = await client.auth.signInAnonymously();
if (signErr) {
  console.log(`abortando: sessão anônima falhou — ${signErr.message}`);
  process.exit(1);
}
const rpc = async (fn, body) => {
  const { data, error } = await client.rpc(fn, body);
  if (error) console.log(`  !! ${fn} -> ${error.code ?? ""} ${error.message.slice(0, 200)}`);
  return error ? { __error: error } : data;
};

const db = new pg.Client({
  connectionString: DB_URL,
  ssl: /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false,
});
await db.connect();
let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const status = async (rid) => (await one(`SELECT status FROM public.rooms WHERE id = $1`, [rid])).status;

const tag = Date.now().toString(36);
const H = `sia_${tag}_h`;
const B1 = `sia_${tag}_b1`;
const B2 = `sia_${tag}_b2`;
const B3 = `sia_${tag}_b3`;

const prevMode = (await one(`SELECT value FROM public.app_config WHERE key = 'ai_mode'`))?.value ?? null;
const evFrom = (await one(`SELECT coalesce(max(id), 0) AS id FROM public.ops_events`)).id;
let rid = null;

try {
  await db.query(
    `INSERT INTO public.app_config (key, value) VALUES ('ai_mode', 'suspenso')
     ON CONFLICT (key) DO UPDATE SET value = 'suspenso', updated_at = now()`,
  );
  check("ai_mode = 'suspenso' durante a partida", (await one(`SELECT value FROM public.app_config WHERE key = 'ai_mode'`)).value === "suspenso");

  const room = await rpc("create_room_with_host", {
    p_host_id: H, p_nickname: "Sem IA", p_avatar: "🤖", p_color: "#abc",
  });
  check("create_room_with_host", !!room?.id, room?.code ?? JSON.stringify(room).slice(0, 120));
  if (!room?.id) throw new Error("sem sala");
  rid = room.id;

  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot) VALUES
     ($2, $1, 'Bot1', '🦊', '#111', true), ($3, $1, 'Bot2', '🐸', '#222', true), ($4, $1, 'Bot3', '🦉', '#333', true)`,
    [rid, B1, B2, B3],
  );
  // 2 rodadas fixas: o placar da 1ª vai para a 2ª; o da 2ª encerra a partida
  await db.query(`UPDATE public.rooms SET win_condition = 'rounds', win_target = 2 WHERE id = $1`, [rid]);

  const sg = await rpc("start_game", { p_room_id: rid });
  check("start_game", sg?.ok === true, JSON.stringify(sg));

  const { rows: words } = await db.query(
    `SELECT id FROM public.words WHERE meaning IS NOT NULL AND id IS DISTINCT FROM (SELECT word_id FROM public.daily_challenges WHERE challenge_hour = date_trunc('hour', now())) ORDER BY id LIMIT 2`,
  );
  check("2 palavras com significado no acervo do teste", words.length === 2, `n=${words.length}`);

  for (let round = 1; round <= 2; round++) {
    console.log(`\n— rodada ${round}`);
    // coordenador determinístico = host (humano), como no test-e2e-round
    await db.query(`UPDATE public.rooms SET current_coordinator = $2 WHERE id = $1`, [rid, H]);
    check(`r${round}: status = choosing`, (await status(rid)) === "choosing", await status(rid));

    const cw = await rpc("choose_word", { p_room_id: rid, p_word_id: words[round - 1].id, p_duration_sec: 60 });
    check(`r${round}: choose_word`, !cw?.__error, JSON.stringify(cw ?? null).slice(0, 80));
    check(`r${round}: status = writing`, (await status(rid)) === "writing", await status(rid));

    // bots pelas reservas (o que o cliente faz com a IA suspensa): texto puro, sem IA
    const bulk = await rpc("submit_bot_definitions_bulk", {
      p_room_id: rid, p_round: round,
      p_rows: [
        { player_id: B1, text: `objeto antigo de cozinha ${round}` },
        { player_id: B2, text: `planta rasteira do litoral ${round}` },
        { player_id: B3, text: `dança popular do interior ${round}` },
      ],
    });
    check(`r${round}: definições dos bots (reservas) aceitas`, !bulk?.__error);

    await rpc("advance_writing_to_voting", { p_room_id: rid });
    if ((await status(rid)) === "shuffling") await rpc("advance_writing_to_voting", { p_room_id: rid });
    check(`r${round}: status = voting`, (await status(rid)) === "voting", await status(rid));

    const { rows: defs } = await db.query(
      `SELECT id, player_id FROM public.definitions WHERE room_id = $1 AND round = $2`, [rid, round]);
    const truth = defs.find((d) => d.player_id === "__truth__");
    const defB1 = defs.find((d) => d.player_id === B1);
    check(`r${round}: verdade inserida pelo servidor`, !!truth && !!defB1, `n=${defs.length}`);

    await db.query(`SELECT public.cast_votes_bulk($1, $2, $3::jsonb)`, [
      rid, round,
      JSON.stringify([
        { voter_id: B1, definition_id: truth.id },
        { voter_id: B3, definition_id: truth.id },
        { voter_id: B2, definition_id: defB1.id },
      ]),
    ]);
    await rpc("cast_vote", { p_room_id: rid, p_voter_id: H, p_definition_id: defB1.id });

    await rpc("advance_voting_to_reveal", { p_room_id: rid });
    check(`r${round}: status = reveal (sem esperar juiz)`, (await status(rid)) === "reveal", await status(rid));

    const rr = await one(`SELECT scored_at, judged_at FROM public.rounds WHERE room_id = $1 AND round = $2`, [rid, round]);
    check(`r${round}: rodada pontuada (scored_at) mesmo sem juiz`, !!rr?.scored_at, JSON.stringify(rr));

    const rev = await rpc("get_room_reveal", { p_room_id: rid });
    const nearIds = rev?.near_truth_ids ?? [];
    check(`r${round}: revelação sem 🧠 (near_truth_ids vazio)`, !rev?.__error && nearIds.length === 0, JSON.stringify(nearIds));
    const nt = await one(
      `SELECT count(*)::int AS n FROM public.definitions WHERE room_id = $1 AND round = $2 AND near_truth IS TRUE`, [rid, round]);
    check(`r${round}: nenhuma definição marcada near_truth`, nt.n === 0, `n=${nt.n}`);

    // revelação → placar: só o tempo desde scored_at conta (o cron faz isso)
    await db.query(`UPDATE public.rounds SET scored_at = now() - interval '10 minutes' WHERE room_id = $1 AND round = $2`, [rid, round]);
    await db.query(`SELECT public.advance_reveal_to_scoreboard($1)`, [rid]);
    check(`r${round}: status = scoreboard (judged_at ${rr?.judged_at ? "preenchido" : "NULO"} não bloqueia)`, (await status(rid)) === "scoreboard", await status(rid));

    await db.query(`UPDATE public.rooms SET round_phase_ends_at = now() - interval '1 second' WHERE id = $1`, [rid]);
    const nx = await one(`SELECT public.advance_scoreboard_to_next_round_or_finished($1) AS r`, [rid]);
    const want = round < 2 ? "next_round" : "finished";
    check(`r${round}: placar → ${want}`, nx.r?.action === want, JSON.stringify(nx.r));
  }

  check("partida terminou (status = finished)", (await status(rid)) === "finished", await status(rid));

  const { rows: sc } = await db.query(`SELECT id, score FROM public.players WHERE room_id = $1`, [rid]);
  const S = Object.fromEntries(sc.map((p) => [p.id, p.score]));
  // por rodada: b1 +3 (verdade) +2 (enganou b2 e host); b3 +3; b2 0; host 0
  check("placar final = regra congelada sem bônus 🧠 (b1 10, b3 6, b2 0, host 0)",
    S[B1] === 10 && S[B3] === 6 && S[B2] === 0 && S[H] === 0, JSON.stringify(S));

  const ev = await one(
    `SELECT count(*)::int AS n FROM public.ops_events WHERE id > $1 AND (kind LIKE 'judge_ai_%' OR kind LIKE 'bot_ai_%')`, [evFrom]);
  check("nenhum evento judge_ai_*/bot_ai_* durante a partida", ev.n === 0, `n=${ev.n}`);
} catch (e) {
  check("partida sem IA executou sem exceção", false, String(e?.message ?? e).slice(0, 200));
} finally {
  if (prevMode === null) await db.query(`DELETE FROM public.app_config WHERE key = 'ai_mode'`);
  else await db.query(`UPDATE public.app_config SET value = $1 WHERE key = 'ai_mode'`, [prevMode]);
  if (rid) await db.query(`DELETE FROM public.rooms WHERE id = $1`, [rid]);
  await db.query(`DELETE FROM public.players WHERE id LIKE $1`, [`sia_${tag}_%`]);
  await db.end();
}
console.log(fails ? `\n${fails} FALHAS` : "\nPARTIDA SEM IA OK — motor não depende do juiz");
process.exit(fails ? 1 : 0);
