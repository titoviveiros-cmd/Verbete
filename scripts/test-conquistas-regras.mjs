// Testes da migration 20261122120000_conquistas_regras.sql (19/11/2026), em banco ISOLADO.
//   node scripts/test-conquistas-regras.mjs --pglite <pasta do @electric-sql/pglite>
// Monta um esquema mínimo, aplica as funções ORIGINAIS (produção), cria dados, aplica a
// migration, confere regras/limites/idempotência/preservação e por fim o rollback.
// Limite: PGlite tem 1 conexão — concorrência real fica para o modo Postgres (CI); aqui a
// "requisição concorrente" é simulada por concessão prévia da mesma conquista.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fnBlock } from "./gerar-conquistas-regras.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const args = process.argv.slice(2);
const pglitePath = args[args.indexOf("--pglite") + 1];
if (!args.includes("--pglite") || !pglitePath) {
  console.error(
    "uso: node scripts/test-conquistas-regras.mjs --pglite <pasta do @electric-sql/pglite>",
  );
  process.exit(2);
}
const { PGlite } = await import(
  pathToFileURL(join(pglitePath, "dist", "index.js")).href
);
const pg = new PGlite();
// o Supabase roda em UTC; o PGlite pega o fuso da máquina (aqui -03) e esconderia erro de fuso
await pg.exec("SET TIME ZONE 'UTC'");
const q = async (s, p = []) => (await pg.query(s, p)).rows;
const exec = (s) => pg.exec(s);

let ok = 0;
const falhas = [];
const t = async (nome, fn) => {
  try {
    await fn();
    ok++;
    console.log(`  ✓ ${nome}`);
  } catch (e) {
    falhas.push(nome);
    console.log(`  ✗ ${nome}\n      ${e.message}`);
  }
};
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(
      `${msg}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`,
    );
};

const MIG = rd("supabase/migrations/20261122120000_conquistas_regras.sql");
const RB = rd("supabase/rollback/conquistas_regras.sql");
const ORIG = {
  scored: fnBlock(
    rd(
      "supabase/migrations/20260608161016_4a498957-8605-4dfc-a9cd-494245ccb841.sql",
    ),
    "submit_daily_attempt_scored",
  ),
  part: fnBlock(
    rd("supabase/migrations/20261108120000_diario_d1_escolha.sql"),
    "daily_record_participation",
  ),
  match: fnBlock(
    rd("supabase/migrations/20261112110000_rooms_leitura_restrita.sql"),
    "record_match_result",
  ),
};
const XP = fnBlock(
  rd("supabase/migrations/20260713120000_xp_achievements.sql"),
  "xp_to_level",
);

// ------------------------------------------------------------------ esquema mínimo + funções originais
await exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA extensions;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('t.uid', true), '')::uuid $$;
  CREATE TABLE public.user_stats (
    user_id uuid PRIMARY KEY, games_played int NOT NULL DEFAULT 0, games_won int NOT NULL DEFAULT 0,
    total_score int NOT NULL DEFAULT 0, current_streak int NOT NULL DEFAULT 0, best_streak int NOT NULL DEFAULT 0,
    last_played_date date, last_played_hour timestamptz, best_match_score int NOT NULL DEFAULT 0,
    rounds_coordinated int NOT NULL DEFAULT 0, total_truth_hits int NOT NULL DEFAULT 0, total_fooled int NOT NULL DEFAULT 0,
    win_streak int NOT NULL DEFAULT 0, best_win_streak int NOT NULL DEFAULT 0, xp int NOT NULL DEFAULT 0,
    level int NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.achievements (code text PRIMARY KEY, name text, description text, emoji text, rarity text);
  INSERT INTO public.achievements (code, description) VALUES
    ('first_daily','x'),('streak_3','x'),('streak_7','x'),('streak_30','x'),('first_win','x'),('partidas_10','x'),
    ('acertos_100','x'),('bluffs_100','x'),('invicto_3','x'),('maior_enganador','Engane 5 ou mais jogadores numa única partida.'),
    ('truth_seeker','x'),('coordinator_5','x'),('big_score','x'),('bluff_master','x'),('social_butterfly','x');
  CREATE TABLE public.user_achievements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
    achievement_code text NOT NULL, unlocked_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, achievement_code));
  CREATE TABLE public.words (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), word text, meaning text);
  CREATE TABLE public.daily_challenges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), challenge_date date,
    challenge_hour timestamptz UNIQUE, word_id uuid);
  CREATE TABLE public.daily_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
    challenge_date date, challenge_hour timestamptz NOT NULL, guess text, is_correct boolean, score int,
    time_seconds int, similarity int, mode text NOT NULL DEFAULT 'juiz', created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, challenge_hour));
  CREATE FUNCTION public.get_or_create_daily_challenge(p_date date DEFAULT CURRENT_DATE) RETURNS jsonb LANGUAGE sql AS $$
    INSERT INTO public.daily_challenges (challenge_date, challenge_hour, word_id)
    VALUES (current_date, date_trunc('hour', now()), (SELECT id FROM public.words LIMIT 1))
    ON CONFLICT (challenge_hour) DO NOTHING RETURNING '{}'::jsonb $$;
  INSERT INTO public.words (word, meaning) VALUES ('teste', 'definição');
  CREATE TABLE public.rooms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE, status text, finish_reason text,
    finished_at timestamptz);
  CREATE TABLE public.players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid, user_id uuid,
    is_bot boolean NOT NULL DEFAULT false, score int NOT NULL DEFAULT 0, coordinator_count int NOT NULL DEFAULT 0);
  CREATE TABLE public.definitions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid, player_id uuid, is_truth boolean);
  CREATE TABLE public.votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid, voter_id uuid, definition_id uuid);
  CREATE TABLE public.match_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, room_code text,
    final_score int, position int, players_count int, created_at timestamptz DEFAULT now(),
    played_at timestamptz NOT NULL DEFAULT now());
  CREATE FUNCTION public.is_room_participant(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  ${XP}
  ${ORIG.scored}
  ${ORIG.part}
  ${ORIG.match}
  REVOKE ALL ON FUNCTION public.record_match_result(text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.record_match_result(text) TO authenticated;
  REVOKE ALL ON FUNCTION public.daily_record_participation(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.daily_record_participation(uuid, timestamptz, integer) TO service_role;
`);

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const conquistas = async (u) =>
  (
    await q(
      `SELECT achievement_code c FROM public.user_achievements WHERE user_id = $1 ORDER BY 1`,
      [u],
    )
  ).map((r) => r.c);
const stats = async (u) =>
  (
    await q(
      `SELECT *, last_played_date::text AS lpd FROM public.user_stats WHERE user_id = $1`,
      [u],
    )
  )[0];
const acl = async () =>
  (
    await q(`SELECT has_function_privilege('anon','public.record_match_result(text)','EXECUTE') a,
                   has_function_privilege('authenticated','public.record_match_result(text)','EXECUTE') b,
                   has_function_privilege('authenticated','public.daily_record_participation(uuid,timestamptz,integer)','EXECUTE') c,
                   has_function_privilege('service_role','public.daily_record_participation(uuid,timestamptz,integer)','EXECUTE') d`)
  )[0];

// ------------------------------------------------------------------ dados ANTES da migration (contadores em horas)
// u1: tem histórico no Diário (dias BRT 01, 02, 03 de nov, falta 04, joga 05 duas vezes); streak em horas = 7.
const H = (iso) => new Date(iso).toISOString();
for (const h of [
  "2026-11-01T15:00Z",
  "2026-11-02T13:00Z",
  "2026-11-03T20:00Z",
  "2026-11-05T14:00Z",
  "2026-11-05T15:00Z",
])
  await q(
    `INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, score) VALUES ($1, ($2::timestamptz)::date, $2::timestamptz, 10)`,
    [U(1), H(h)],
  );
await q(
  `INSERT INTO public.user_stats (user_id, current_streak, best_streak, last_played_date, last_played_hour, total_score, xp)
         VALUES ($1, 2, 7, '2026-11-05', '2026-11-05T15:00Z', 999, 500)`,
  [U(1)],
);
// u2: sem histórico no Diário, mas com sequência em horas (12) — não pode virar "12 dias"
await q(
  `INSERT INTO public.user_stats (user_id, current_streak, best_streak, total_score) VALUES ($1, 3, 12, 77)`,
  [U(2)],
);
// u9: conquista já concedida antes (preservação)
await q(
  `INSERT INTO public.user_achievements (user_id, achievement_code) VALUES ($1, 'streak_30')`,
  [U(9)],
);
const aclAntes = await acl();
const placarAntes = await q(
  `SELECT user_id, total_score, xp FROM public.user_stats ORDER BY 1`,
);

console.log("migration");
await exec(MIG);

await t("permissões das funções preservadas (CREATE OR REPLACE)", async () =>
  eq(await acl(), aclAntes, "ACL"),
);
await t("pontuação e XP preservados na conversão", async () =>
  eq(
    await q(
      `SELECT user_id, total_score, xp FROM public.user_stats ORDER BY 1`,
    ),
    placarAntes,
    "placar",
  ),
);
await t("conquista já concedida continua lá", async () =>
  eq(await conquistas(U(9)), ["streak_30"], "u9"),
);
await t(
  "conversão horas→dias pelo histórico (01–03 = 3 dias; falta 04; 05 duas vezes = 1)",
  async () => {
    const s = await stats(U(1));
    eq([s.current_streak, s.best_streak, s.lpd], [1, 3, "2026-11-05"], "u1");
  },
);
await t(
  "sem histórico no Diário: sequência em horas não vira dias (zera; backup guarda 12)",
  async () => {
    const s = await stats(U(2));
    eq([s.current_streak, s.best_streak], [0, 0], "u2");
    eq(
      (
        await q(
          `SELECT best_streak FROM public.conquistas_streak_horas_bkp WHERE user_id = $1`,
          [U(2)],
        )
      )[0].best_streak,
      12,
      "backup",
    );
  },
);
await t("descrição do Maior Enganador alinhada aos votos", async () =>
  eq(
    (
      await q(
        `SELECT description d FROM public.achievements WHERE code='maior_enganador'`,
      )
    )[0].d,
    "Receba pelo menos 5 votos nas suas definições falsas em uma única partida.",
    "descrição",
  ),
);

// ------------------------------------------------------------------ Diário: sequência por dia (modo escolha, hora como parâmetro)
const jogar = async (u, iso, pontos = 10) =>
  (
    await q(
      `SELECT public.daily_record_participation($1, $2::timestamptz, $3) r`,
      [u, H(iso), pontos],
    )
  )[0].r;
console.log("Diário");
await t(
  "várias jogadas no mesmo dia não aumentam a sequência; pontos somam como antes",
  async () => {
    const u = U(10);
    for (const h of [
      "2026-11-10T12:00Z",
      "2026-11-10T13:00Z",
      "2026-11-10T20:00Z",
    ])
      await jogar(u, h, 10);
    const s = await stats(u);
    eq([s.current_streak, s.total_score], [1, 30], "mesmo dia");
  },
);
await t(
  "virada do dia no horário de Brasília (02:00Z ainda é o dia anterior; 03:00Z é o seguinte)",
  async () => {
    const u = U(11);
    await jogar(u, "2026-11-10T15:00Z"); // 12h BRT de 10/11
    eq(
      (await jogar(u, "2026-11-11T02:00Z")).current_streak,
      1,
      "23h BRT de 10/11 = mesmo dia",
    );
    eq(
      (await jogar(u, "2026-11-11T03:00Z")).current_streak,
      2,
      "00h BRT de 11/11 = dia seguinte",
    );
  },
);
await t("dia perdido recomeça em 1", async () => {
  const u = U(12);
  await jogar(u, "2026-11-10T15:00Z");
  await jogar(u, "2026-11-11T15:00Z");
  eq((await jogar(u, "2026-11-13T15:00Z")).current_streak, 1, "pulou 12/11");
});
const dias = async (u, n, inicio = "2026-10-01") => {
  const r = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(`${inicio}T15:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    r.push(await jogar(u, d.toISOString()));
  }
  return r;
};
await t("Em Chamas exatamente no 3º dia (não no 2º)", async () => {
  const r = await dias(U(13), 3);
  eq(
    r.map((x) => x.unlocked.includes("streak_3")),
    [false, false, true],
    "streak_3",
  );
});
await t(
  "Semana Perfeita exatamente no 7º dia; Lenda do Verbete exatamente no 30º",
  async () => {
    const r = await dias(U(14), 30);
    eq(
      r.findIndex((x) => x.unlocked.includes("streak_7")),
      6,
      "streak_7",
    );
    eq(
      r.findIndex((x) => x.unlocked.includes("streak_30")),
      29,
      "streak_30",
    );
    eq((await stats(U(14))).best_streak, 30, "best");
  },
);
await t("requisição repetida não duplica conquista nem relista", async () => {
  const u = U(15);
  await dias(u, 3);
  const r = await jogar(u, "2026-10-03T15:00Z"); // repete o 3º dia
  eq(r.unlocked, [], "unlocked");
  eq(
    (
      await q(
        `SELECT count(*)::int n FROM public.user_achievements WHERE user_id=$1 AND achievement_code='streak_3'`,
        [u],
      )
    )[0].n,
    1,
    "1 linha",
  );
});
await t(
  "concorrente já concedeu (linha prévia): não aborta e não relista",
  async () => {
    const u = U(16);
    await q(
      `INSERT INTO public.user_achievements (user_id, achievement_code) VALUES ($1,'first_daily')`,
      [u],
    );
    const r = await jogar(u, "2026-10-01T15:00Z");
    eq(r.unlocked, [], "unlocked");
  },
);
await t(
  "modo juiz: trecho de sequência/concessões IDÊNTICO ao do modo escolha",
  async () => {
    const corte = (sql) => {
      const i = sql.indexOf("  -- Sequência por DIA");
      return sql.slice(i, sql.indexOf("  RETURN jsonb_build_object(", i));
    };
    const a = corte(fnBlock(MIG, "submit_daily_attempt_scored"));
    const b = corte(fnBlock(MIG, "daily_record_participation"));
    if (!a.includes("v_day :=") || a !== b)
      throw new Error("trechos diferentes");
  },
);
await t(
  "modo juiz: jogada real (agora) grava, conta 1 e concede o primeiro Diário",
  async () => {
    const u = U(17);
    const r = (
      await q(`SELECT public.submit_daily_attempt_scored($1, 'x', 30, 90) r`, [
        u,
      ])
    )[0].r;
    eq(
      [r.current_streak, (await conquistas(u)).includes("first_daily")],
      [1, true],
      "juiz",
    );
    const r2 = (
      await q(`SELECT public.submit_daily_attempt_scored($1, 'x', 30, 90) r`, [
        u,
      ])
    )[0].r;
    eq(r2.already_played, true, "repetição");
  },
);

// ------------------------------------------------------------------ Partida
console.log("Partida");
let sala = 0;
async function partida(
  u,
  { score = 0, coord = 0, votos = [], acertos = 0, base = {} } = {},
) {
  const code = `S${String(++sala).padStart(3, "0")}`;
  const room = (
    await q(
      `INSERT INTO public.rooms (code, status, finished_at) VALUES ($1,'finished', clock_timestamp()) RETURNING id`,
      [code],
    )
  )[0].id;
  const eu = (
    await q(
      `INSERT INTO public.players (room_id,user_id,score,coordinator_count) VALUES ($1,$2,$3,$4) RETURNING id`,
      [room, u, score, coord],
    )
  )[0].id;
  const outros = [];
  for (let i = 0; i < 8; i++)
    outros.push(
      (
        await q(
          `INSERT INTO public.players (room_id,user_id) VALUES ($1,$2) RETURNING id`,
          [room, U(9000 + sala * 10 + i)],
        )
      )[0].id,
    );
  // votos[i] = quantos outros votaram na minha i-ésima definição falsa
  for (const n of votos) {
    const d = (
      await q(
        `INSERT INTO public.definitions (room_id,player_id,is_truth) VALUES ($1,$2,false) RETURNING id`,
        [room, eu],
      )
    )[0].id;
    for (let k = 0; k < n; k++)
      await q(
        `INSERT INTO public.votes (room_id,voter_id,definition_id) VALUES ($1,$2,$3)`,
        [room, outros[k], d],
      );
  }
  if (acertos) {
    const v = (
      await q(
        `INSERT INTO public.definitions (room_id,player_id,is_truth) VALUES ($1,NULL,true) RETURNING id`,
        [room],
      )
    )[0].id;
    for (let k = 0; k < acertos; k++)
      await q(
        `INSERT INTO public.votes (room_id,voter_id,definition_id) VALUES ($1,$2,$3)`,
        [room, eu, v],
      );
  }
  if (Object.keys(base).length)
    await q(
      `INSERT INTO public.user_stats (user_id, total_truth_hits, rounds_coordinated) VALUES ($1,$2,$3)
             ON CONFLICT (user_id) DO UPDATE SET total_truth_hits=$2, rounds_coordinated=$3`,
      [u, base.truth ?? 0, base.coord ?? 0],
    );
  await exec(`SELECT set_config('t.uid', '${u}', false)`);
  return (await q(`SELECT public.record_match_result($1) r`, [code]))[0].r;
}
await t(
  "Caçador da Verdade exatamente ao chegar a 10 acertos (9 não)",
  async () => {
    eq(
      (
        await partida(U(20), { base: { truth: 8 }, acertos: 1 })
      ).unlocked.includes("truth_seeker"),
      false,
      "9",
    );
    eq(
      (await partida(U(20), { acertos: 1 })).unlocked.includes("truth_seeker"),
      true,
      "10",
    );
  },
);
await t(
  "Coordenador Nato exatamente na 5ª rodada coordenada (4 não)",
  async () => {
    eq(
      (
        await partida(U(21), { base: { coord: 2 }, coord: 2 })
      ).unlocked.includes("coordinator_5"),
      false,
      "4",
    );
    eq(
      (await partida(U(21), { coord: 1 })).unlocked.includes("coordinator_5"),
      true,
      "5",
    );
  },
);
await t("Pontuação Massiva com 30 pontos (29 não)", async () => {
  eq(
    (await partida(U(22), { score: 29 })).unlocked.includes("big_score"),
    false,
    "29",
  );
  eq(
    (await partida(U(22), { score: 30 })).unlocked.includes("big_score"),
    true,
    "30",
  );
});
await t(
  "Mestre do Blefe: 5 votos numa ÚNICA definição falsa; 4+4 em duas não (mas Maior Enganador sim)",
  async () => {
    const r1 = await partida(U(23), { votos: [4, 4] });
    eq(
      [
        r1.unlocked.includes("bluff_master"),
        r1.unlocked.includes("maior_enganador"),
      ],
      [false, true],
      "4+4",
    );
    const r2 = await partida(U(23), { votos: [5] });
    eq(r2.unlocked.includes("bluff_master"), true, "5");
  },
);
await t(
  "partida repetida (dedupe) não concede de novo nem duplica",
  async () => {
    const u = U(24);
    await partida(u, { score: 30 });
    await exec(`SELECT set_config('t.uid', '${u}', false)`);
    const r = (
      await q(`SELECT public.record_match_result($1) r`, [
        `S${String(sala).padStart(3, "0")}`,
      ])
    )[0].r;
    eq(
      [
        r.deduped,
        (await conquistas(u)).filter((c) => c === "big_score").length,
      ],
      [true, 1],
      "dedupe",
    );
  },
);
// 20/11/2026 (auditoria P1): dedup por PARTIDA, não por sala
const registrar = async (u, code) => {
  await exec(`SELECT set_config('t.uid', '${u}', false)`);
  return (await q(`SELECT public.record_match_result($1) r`, [code]))[0].r;
};
const historico = async (u) =>
  (
    await q(
      `SELECT count(*)::int n FROM public.match_history WHERE user_id = $1`,
      [u],
    )
  )[0].n;
await t(
  "revanche (mesmo código, nova partida) rende de novo; repetir a revanche deduplica",
  async () => {
    const u = U(60);
    const r1 = await partida(u, { score: 10 });
    const code = `S${String(sala).padStart(3, "0")}`;
    // reset_room volta a sala ao lobby (gatilho zera finished_at); o fim novo refaz finished_at
    await q(
      `UPDATE public.rooms SET status = 'lobby', finished_at = NULL WHERE code = $1`,
      [code],
    );
    await q(
      `UPDATE public.rooms SET status = 'finished', finished_at = clock_timestamp() WHERE code = $1`,
      [code],
    );
    const r2 = await registrar(u, code);
    const r3 = await registrar(u, code);
    eq(
      [
        !!r1.deduped,
        !!r2.deduped,
        r2.xp_gained > 0,
        !!r3.deduped,
        await historico(u),
      ],
      [false, false, true, true, 2],
      "revanche",
    );
  },
);
await t(
  "sala antiga sem finished_at: segue a regra antiga (1 registro por sala)",
  async () => {
    const u = U(61);
    await partida(u, { score: 10 });
    const code = `S${String(sala).padStart(3, "0")}`;
    await q(`UPDATE public.rooms SET finished_at = NULL WHERE code = $1`, [
      code,
    ]);
    const r = await registrar(u, code);
    eq([!!r.deduped, await historico(u)], [true, 1], "legado");
  },
);
await t(
  "pontuação/XP/estatísticas da partida iguais às da função ORIGINAL",
  async () => {
    // mesma partida com a função antiga (num banco à parte) e com a nova
    const cols =
      "games_played,games_won,total_score,best_match_score,rounds_coordinated,total_truth_hits,total_fooled,win_streak,best_win_streak,xp,level";
    const u = U(25);
    const rNovo = await partida(u, {
      score: 31,
      coord: 2,
      votos: [5, 1],
      acertos: 2,
    });
    const novo = (
      await q(`SELECT ${cols} FROM public.user_stats WHERE user_id=$1`, [u])
    )[0];
    await exec(ORIG.match);
    const u2 = U(26);
    const rVelho = await partida(u2, {
      score: 31,
      coord: 2,
      votos: [5, 1],
      acertos: 2,
    });
    const velho = (
      await q(`SELECT ${cols} FROM public.user_stats WHERE user_id=$1`, [u2])
    )[0];
    await exec(fnBlock(MIG, "record_match_result"));
    eq(novo, velho, "user_stats");
    eq(rNovo.xp_gained, rVelho.xp_gained, "xp_gained");
  },
);

// ------------------------------------------------------------------ progresso DEPOIS da migration (o rollback não pode perder)
console.log("progresso depois da migration");
// participação real: a linha em daily_attempts (como daily_choice_finish/submit) + a sequência
const jogarComRegistro = async (u, iso, pontos = 10) => {
  await q(
    `INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, score, mode) VALUES ($1, ($2::timestamptz)::date, $2::timestamptz, $3, 'escolha')`,
    [u, H(iso), pontos],
  );
  return jogar(u, iso, pontos);
};
// u1 (backup em horas: 2/7, última hora 05/11 15:00Z) joga 16:00Z e 17:00Z
await jogarComRegistro(U(1), "2026-11-05T16:00Z");
await jogarComRegistro(U(1), "2026-11-05T17:00Z");
// u31: conta nova depois da migration (fora do backup): 3 horas seguidas
for (const h of ["2026-11-06T10:00Z", "2026-11-06T11:00Z", "2026-11-06T12:00Z"])
  await jogarComRegistro(U(31), h);
// partidas depois da migration: XP, pontuação, estatísticas e conquistas novas
const pU1 = await partida(U(1), {
  score: 31,
  coord: 1,
  votos: [5],
  acertos: 1,
});
const COLS_PROGRESSO =
  "user_id,games_played,games_won,total_score,best_match_score,rounds_coordinated,total_truth_hits,total_fooled,win_streak,best_win_streak,xp,level";
const progressoAntesRb = await q(
  `SELECT ${COLS_PROGRESSO} FROM public.user_stats ORDER BY user_id`,
);
const conquistasAntesRb = await q(
  `SELECT user_id, achievement_code, unlocked_at FROM public.user_achievements ORDER BY 1, 2`,
);
const tentativasAntesRb = await q(
  `SELECT user_id, challenge_hour, score, mode FROM public.daily_attempts ORDER BY 1, 2`,
);

// ------------------------------------------------------------------ rollback
console.log("rollback");
await exec(RB);
await t(
  "rollback preserva XP, pontuação, estatísticas de partida, conquistas e tentativas (inclusive as de depois da migration)",
  async () => {
    eq(
      [pU1.xp_gained > 0, pU1.unlocked.includes("big_score")],
      [true, true],
      "partida nova: XP e conquista",
    );
    eq(
      await q(
        `SELECT ${COLS_PROGRESSO} FROM public.user_stats ORDER BY user_id`,
      ),
      progressoAntesRb,
      "progresso",
    );
    eq(
      await q(
        `SELECT user_id, achievement_code, unlocked_at FROM public.user_achievements ORDER BY 1, 2`,
      ),
      conquistasAntesRb,
      "conquistas",
    );
    eq(
      await q(
        `SELECT user_id, challenge_hour, score, mode FROM public.daily_attempts ORDER BY 1, 2`,
      ),
      tentativasAntesRb,
      "tentativas",
    );
  },
);
await t(
  "rollback: sequência em horas continua o Diário jogado depois (backup + horas novas); quem não jogou volta ao backup",
  async () => {
    const s1 = await stats(U(1));
    eq(
      [
        s1.current_streak,
        s1.best_streak,
        s1.lpd,
        new Date(s1.last_played_hour).toISOString(),
      ],
      [4, 7, "2026-11-05", "2026-11-05T17:00:00.000Z"],
      "u1 = backup 2 + 16h + 17h",
    );
    const s2 = await stats(U(2));
    eq([s2.current_streak, s2.best_streak], [3, 12], "u2 = backup exato");
    const s31 = await stats(U(31));
    eq(
      [s31.current_streak, s31.best_streak],
      [3, 3],
      "u31 (conta nova) em horas",
    );
    eq(
      (await q(`SELECT to_regclass('public.conquistas_streak_horas_bkp') r`))[0]
        .r,
      null,
      "backup removido",
    );
  },
);
await t(
  "depois do rollback, a função antiga segue a sequência sem quebra (hora seguinte = +1)",
  async () => {
    const r = await jogarComRegistro(U(1), "2026-11-05T18:00Z");
    eq(r.current_streak, 5, "u1 18h");
    eq((await stats(U(1))).best_streak, 7, "melhor");
  },
);
await t(
  "rollback devolve os 3 corpos de produção, a descrição e os contadores; mantém conquistas",
  async () => {
    const src = async (n) =>
      (await q(`SELECT prosrc FROM pg_proc WHERE proname=$1`, [n]))[0].prosrc;
    const corpo = (b) => {
      const m = /AS (\$[A-Za-z_]*\$)/.exec(b);
      const ini = m.index + m[0].length;
      return b.slice(ini, b.indexOf(m[1], ini));
    };
    eq(await src("submit_daily_attempt_scored"), corpo(ORIG.scored), "scored");
    eq(await src("daily_record_participation"), corpo(ORIG.part), "part");
    eq(await src("record_match_result"), corpo(ORIG.match), "match");
    eq(
      (
        await q(
          `SELECT description d FROM public.achievements WHERE code='maior_enganador'`,
        )
      )[0].d,
      "Engane 5 ou mais jogadores numa única partida.",
      "desc",
    );
    eq(
      (await conquistas(U(23))).includes("bluff_master"),
      true,
      "conquista mantida",
    );
    eq(await acl(), aclAntes, "ACL");
  },
);

await pg.close();
console.log(
  `\n${ok}/${ok + falhas.length} PASS${falhas.length ? ` — FALHAS: ${falhas.join("; ")}` : ""}`,
);
process.exit(falhas.length ? 1 : 0);
