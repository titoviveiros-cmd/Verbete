// Resultado compartilhado (09/11/2026): testes SQL da migration 20261109100000_compartilhar_resultado.sql.
//   node scripts/test-match-share.mjs --pglite <pasta do @electric-sql/pglite>   (offline, esquema mínimo)
//   DB_URL=postgres://…127.0.0.1… node scripts/test-match-share.mjs              (CI: Supabase local)
// Só aceita banco LOCAL. Limpa o que cria.
// Red Team 08/11 (A): o retrato é CONGELADO NO FIM DA PARTIDA (gatilho); sair,
// ser expulso, entrar pelo código ou trocar o apelido DEPOIS do fim não muda o link.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const MIG = rd("supabase/migrations/20261109100000_compartilhar_resultado.sql");
const ROLLBACK = rd("supabase/rollback/compartilhar_resultado.sql");

const args = process.argv.slice(2);
const pglitePath = args.includes("--pglite")
  ? args[args.indexOf("--pglite") + 1]
  : null;
const modePg = !pglitePath;
const DB_URL = process.env.DB_URL ?? process.env.DATABASE_URL;
if (modePg) {
  if (!DB_URL) {
    console.error(
      "✖ DB_URL ausente: este teste NÃO pode passar sem um Postgres real.",
    );
    process.exit(1);
  }
  const host = new URL(DB_URL).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    console.error(`✖ recusado: DB_URL aponta para "${host}". Só banco LOCAL.`);
    process.exit(1);
  }
}

let db;
if (modePg) {
  const { default: pg } = await import("pg");
  const main = new pg.Client({ connectionString: DB_URL });
  await main.connect();
  db = {
    q: async (s, p = []) => (await main.query(s, p)).rows,
    exec: (s) => main.query(s),
    close: () => main.end(),
  };
} else {
  const { PGlite } = await import(
    pathToFileURL(join(pglitePath, "dist", "index.js")).href
  );
  const pgl = await PGlite.create();
  db = {
    q: async (s, p = []) => (await pgl.query(s, p)).rows,
    exec: (s) => pgl.exec(s),
    close: () => pgl.close(),
  };
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
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object" && !(v instanceof Date)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])]),
        )
      : v;
const eq = (a, b, msg) => {
  if (JSON.stringify(canon(a)) !== JSON.stringify(canon(b)))
    throw new Error(
      `${msg ?? "diferente"}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`,
    );
};
const ok = (v, msg) => {
  if (!v) throw new Error(msg ?? "falso");
};

if (!modePg) {
  // espelho do que importa em produção: rooms_track_finished_at (BEFORE) e joined_at
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, is_anonymous boolean NOT NULL DEFAULT false);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    CREATE TABLE public.rooms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, host_id text,
      status text NOT NULL DEFAULT 'lobby', mode text NOT NULL DEFAULT 'individual', teams jsonb NOT NULL DEFAULT '[]'::jsonb,
      current_round integer NOT NULL DEFAULT 0, finish_reason text, finished_at timestamptz);
    CREATE FUNCTION public.rooms_track_finished_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'finished' THEN
        IF TG_OP = 'INSERT' THEN NEW.finished_at := COALESCE(NEW.finished_at, now());
        ELSIF OLD.status IS DISTINCT FROM 'finished' OR NEW.finished_at IS NULL THEN NEW.finished_at := clock_timestamp();
        END IF;
      ELSE NEW.finished_at := NULL; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER rooms_track_finished_at BEFORE INSERT OR UPDATE OF status ON public.rooms
      FOR EACH ROW EXECUTE FUNCTION public.rooms_track_finished_at();
    CREATE TABLE public.players (id text PRIMARY KEY, room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
      nickname text NOT NULL, avatar text NOT NULL DEFAULT '🦊', color text NOT NULL DEFAULT '#000', score integer NOT NULL DEFAULT 0,
      team_id text, is_bot boolean NOT NULL DEFAULT false, user_id uuid, kicked_at timestamptz,
      joined_at timestamptz NOT NULL DEFAULT now());
  `);
  await db.exec(MIG);
}
console.log(
  `Resultado compartilhado — modo ${modePg ? "pg (Postgres real)" : "PGlite (offline)"}`,
);

const tag = Math.random().toString(36).slice(2, 8);
const usuarios = [];
const salas = [];
const novoUsuario = async () => {
  const id = randomUUID();
  usuarios.push(id);
  await db.q(
    `INSERT INTO auth.users (id, email, is_anonymous) VALUES ($1, $2, true)`,
    [id, `${tag}-${id.slice(0, 6)}@exemplo.invalid`],
  );
  return id;
};
let seq = 0;
/**
 * Sala com jogadores, que TERMINA pelo caminho real (UPDATE de status → gatilhos).
 * legado: entra já encerrada (INSERT), como uma partida de antes da migration.
 */
const novaSala = async ({
  fim = "finished",
  mode = "individual",
  teams = [],
  finishReason = null,
  jogadores = [],
  legado = false,
} = {}) => {
  const [{ id }] = await db.q(
    `INSERT INTO public.rooms (code, host_id, status, mode, teams, current_round)
     VALUES ($1, $2, $3, $4, $5::jsonb, 3) RETURNING id`,
    [
      String(1000 + Math.floor(Math.random() * 8999)),
      `ms_${tag}_h`,
      legado ? "finished" : "scoreboard",
      mode,
      JSON.stringify(teams),
    ],
  );
  salas.push(id);
  for (const j of jogadores)
    await db.q(
      `INSERT INTO public.players (id, room_id, nickname, avatar, color, score, team_id, is_bot, user_id, joined_at)
       VALUES ($1, $2, $3, '🦊', '#123456', $4, $5, $6, $7, now() - interval '10 minutes')`,
      [
        `ms_${tag}_${++seq}`,
        id,
        j.nick,
        j.score,
        j.team ?? null,
        !!j.bot,
        j.user ?? null,
      ],
    );
  if (!legado && fim !== "nenhum")
    await db.q(
      `UPDATE public.rooms SET status = $2, finish_reason = $3 WHERE id = $1`,
      [id, fim, finishReason],
    );
  return id;
};
const como = async (role, uid, sql, params = []) => {
  await db.exec("BEGIN");
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    if (uid)
      await db.q(
        `SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
        [uid, JSON.stringify({ sub: uid, role })],
      );
    return await db.q(sql, params);
  } finally {
    await db.exec("ROLLBACK");
  }
};
const criar = async (uid, roomId) => {
  await db.exec("BEGIN");
  try {
    await db.exec(`SET LOCAL ROLE authenticated`);
    await db.q(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    const [{ r }] = await db.q(`SELECT public.create_match_share($1) AS r`, [
      roomId,
    ]);
    await db.exec("COMMIT");
    return r;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};
const ler = async (token, role = "anon") =>
  (await como(role, null, `SELECT public.get_match_share($1) AS r`, [token]))[0]
    .r;
const linhas = async (roomId) =>
  (
    await db.q(
      `SELECT count(*)::int AS n FROM public.match_shares WHERE room_id = $1`,
      [roomId],
    )
  )[0].n;
const negado = async (role, sql) => {
  try {
    await como(role, null, sql);
    return false;
  } catch (e) {
    return /permission denied|42501/i.test(
      String(e?.message ?? e) + (e?.code ?? ""),
    );
  }
};

try {
  await t(
    "permissões: tabela fechada; ler = anon/authenticated; obter link = authenticated; internas fechadas",
    async () => {
      for (const r of ["anon", "authenticated"]) {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
          eq(
            (
              await db.q(
                `SELECT has_table_privilege($1, 'public.match_shares', $2) AS p`,
                [r, p],
              )
            )[0].p,
            false,
            `${r} ${p}`,
          );
        ok(
          await negado(r, `SELECT * FROM public.match_shares`),
          `${r} leu a tabela`,
        );
        for (const f of [
          "match_share_snapshot(uuid,timestamptz)",
          "match_share_participants(uuid,timestamptz)",
          "match_share_store(uuid,timestamptz)",
          "match_share_on_finish()",
          "match_shares_cleanup()",
          "match_shares_forget_user()",
        ])
          eq(
            (
              await db.q(
                `SELECT has_function_privilege($1, $2, 'EXECUTE') AS p`,
                [r, `public.${f}`],
              )
            )[0].p,
            false,
            `${r} ${f}`,
          );
        eq(
          (
            await db.q(
              `SELECT has_function_privilege($1, 'public.get_match_share(text)', 'EXECUTE') AS p`,
              [r],
            )
          )[0].p,
          true,
          `${r} lê`,
        );
      }
      eq(
        (
          await db.q(
            `SELECT has_function_privilege('anon', 'public.create_match_share(uuid)', 'EXECUTE') AS p`,
          )
        )[0].p,
        false,
        "anon cria",
      );
      eq(
        (
          await db.q(
            `SELECT has_function_privilege('authenticated', 'public.create_match_share(uuid)', 'EXECUTE') AS p`,
          )
        )[0].p,
        true,
      );
    },
  );

  const H = await novoUsuario();
  const C = await novoUsuario();
  const X = await novoUsuario(); // nunca jogou
  const SALA = await novaSala({
    jogadores: [
      { nick: "Bia", score: 12, user: H },
      { nick: "Zé", score: 15, user: C },
      { nick: "Robô Lu", score: 12, bot: true },
    ],
  });

  await t(
    "o FIM da partida já congela o retrato (gatilho), antes de qualquer clique",
    async () => {
      eq(await linhas(SALA), 1, "o fim da partida não gravou o retrato");
      const em = await novaSala({
        fim: "voting",
        jogadores: [{ nick: "A", score: 1, user: H }],
      });
      eq(await linhas(em), 0, "gravou retrato de partida em andamento");
      const limpeza = await novaSala({
        finishReason: "cleanup_idle",
        jogadores: [{ nick: "A", score: 1, user: H }],
      });
      eq(
        await linhas(limpeza),
        0,
        "gravou retrato de sala encerrada pela limpeza",
      );
    },
  );

  await t(
    "só quem estava no retrato obtém o link; partida não encerrada / limpeza / inexistente recusam",
    async () => {
      eq(await criar(X, SALA), { ok: false, reason: "not_participant" });
      const em = await novaSala({
        fim: "voting",
        jogadores: [{ nick: "A", score: 1, user: H }],
      });
      eq(await criar(H, em), { ok: false, reason: "not_finished" });
      const limpeza = await novaSala({
        finishReason: "cleanup_idle",
        jogadores: [{ nick: "A", score: 1, user: H }],
      });
      eq(await criar(H, limpeza), { ok: false, reason: "not_shareable" });
      eq(await criar(H, randomUUID()), { ok: false, reason: "not_found" });
      eq(
        (
          await como(
            "authenticated",
            null,
            `SELECT public.create_match_share($1) AS r`,
            [SALA],
          )
        )[0].r,
        {
          ok: false,
          reason: "unauthorized",
        },
      );
      ok(
        await negado("anon", `SELECT public.create_match_share('${SALA}')`),
        "anon criou",
      );
    },
  );

  let TOKEN;
  await t(
    "link: token de 32 hex; cliques repetidos (qualquer participante) = MESMO link; campeões do servidor",
    async () => {
      const a = await criar(H, SALA);
      ok(a.ok && /^[0-9a-f]{32}$/.test(a.token), JSON.stringify(a));
      eq(a.champions, [{ name: "Zé", emoji: "🦊", score: 15 }]);
      eq(
        [(await criar(H, SALA)).token, (await criar(C, SALA)).token],
        [a.token, a.token],
      );
      eq(await linhas(SALA), 1);
      TOKEN = a.token;
    },
  );

  await t(
    "retrato do SERVIDOR: ordem, empate na posição, robô marcado; nada de e-mail, UUID, id ou código",
    async () => {
      const r = await ler(TOKEN);
      eq(r.mode, "solo");
      eq(
        r.players.map((p) => [p.rank, p.nickname, p.score, p.bot]),
        [
          [1, "Zé", 15, false],
          [2, "Bia", 12, false],
          [2, "Robô Lu", 12, true],
        ],
      );
      eq(r.rounds, 3);
      ok(r.expires_at, "sem validade");
      const json = JSON.stringify(r);
      ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(json), "vazou UUID");
      ok(!json.includes("@"), "vazou e-mail");
      ok(!json.includes(`ms_${tag}`), "vazou id de jogador");
      const [{ code }] = await db.q(
        `SELECT code FROM public.rooms WHERE id = $1`,
        [SALA],
      );
      ok(
        !/"code"/.test(json) && !json.includes(`"${code}"`),
        "vazou código da sala",
      );
      eq(Object.keys(r.players[0]).sort(), [
        "avatar",
        "bot",
        "color",
        "nickname",
        "rank",
        "score",
        "team",
      ]);
    },
  );

  await t(
    "Red Team A: depois do fim, o vencedor SAI, o anfitrião EXPULSA, alguém ENTRA pelo código e outro TROCA o apelido — o link não muda",
    async () => {
      const V = await novoUsuario(); // vencedor
      const A = await novoUsuario(); // anfitrião
      const L = await novoUsuario(); // entra depois do fim
      const S = await novaSala({
        jogadores: [
          { nick: "Vencedor", score: 30, user: V },
          { nick: "Anfitrião", score: 10, user: A },
          { nick: "Terceiro", score: 5, user: C },
        ],
      });
      // depois do fim:
      await db.q(
        `DELETE FROM public.players WHERE room_id = $1 AND nickname = 'Vencedor'`,
        [S],
      ); // saiu (leave_room em finished)
      await db.q(
        `UPDATE public.players SET kicked_at = now() WHERE room_id = $1 AND nickname = 'Terceiro'`,
        [S],
      ); // expulso
      await db.q(
        `UPDATE public.players SET nickname = 'Trocado' WHERE room_id = $1 AND nickname = 'Anfitrião'`,
        [S],
      ); // apelido
      await db.q(
        `INSERT INTO public.players (id, room_id, nickname, score, user_id, joined_at) VALUES ($1, $2, 'Atrasado', 0, $3, now() + interval '1 minute')`,
        [`ms_${tag}_late`, S, L],
      );
      const a = await criar(A, S);
      ok(a.ok, JSON.stringify(a));
      eq(
        a.champions,
        [{ name: "Vencedor", emoji: "🦊", score: 30 }],
        "campeão mudou depois do fim",
      );
      const r = await ler(a.token);
      eq(
        r.players.map((p) => p.nickname),
        ["Vencedor", "Anfitrião", "Terceiro"],
      );
      eq(
        await criar(L, S),
        { ok: false, reason: "not_participant" },
        "quem entrou depois do fim obteve o link",
      );
      eq(
        (await criar(V, S)).token,
        a.token,
        "o vencedor que saiu ainda pode compartilhar",
      );
    },
  );

  await t("empate: campeões = todos os empatados (servidor)", async () => {
    const S = await novaSala({
      jogadores: [
        { nick: "Zé", score: 9, user: H },
        { nick: "Bia", score: 9, user: C },
        { nick: "Lu", score: 2, bot: true },
      ],
    });
    const a = await criar(H, S);
    eq(
      a.champions.map((x) => x.name),
      ["Bia", "Zé"],
    );
    eq((await ler(a.token)).players.filter((p) => p.rank === 1).length, 2);
  });

  await t(
    "equipes: soma dos membros (como o cliente), posição e equipe campeã",
    async () => {
      const S = await novaSala({
        mode: "teams",
        teams: [
          { id: "a", name: "Corujas", emoji: "🦉", color: "#111" },
          { id: "b", name: "Raposas", emoji: "🦊", color: "#222" },
        ],
        jogadores: [
          { nick: "P1", score: 10, user: H, team: "a" },
          { nick: "P2", score: 3, user: C, team: "a" },
          { nick: "P3", score: 9, team: "b", bot: true },
          { nick: "P4", score: 2, team: "b", bot: true },
        ],
      });
      const a = await criar(H, S);
      eq(a.champions, [{ name: "Corujas", emoji: "🦉", score: 13 }]);
      const r = await ler(a.token);
      eq(r.mode, "teams");
      eq(
        r.teams.map((x) => [x.rank, x.name, x.score, x.members]),
        [
          [1, "Corujas", 13, 2],
          [2, "Raposas", 11, 2],
        ],
      );
      eq(r.players.find((p) => p.nickname === "P3").team, "Raposas");
    },
  );

  await t(
    "Nova partida na mesma sala: link NOVO para a nova; o antigo continua mostrando a anterior",
    async () => {
      const S = await novaSala({
        jogadores: [
          { nick: "Ana", score: 9, user: H },
          { nick: "Beto", score: 3, user: C },
        ],
      });
      const a = await criar(H, S);
      await db.q(`UPDATE public.rooms SET status = 'lobby' WHERE id = $1`, [S]); // revanche (reset_room)
      await db.q(
        `UPDATE public.players SET score = CASE nickname WHEN 'Ana' THEN 1 ELSE 20 END WHERE room_id = $1`,
        [S],
      );
      await db.q(`UPDATE public.rooms SET status = 'finished' WHERE id = $1`, [
        S,
      ]); // fim da 2ª partida
      const b = await criar(C, S);
      ok(
        b.ok && b.token !== a.token,
        "a revanche reaproveitou o link da partida anterior",
      );
      eq((await ler(a.token)).players[0].nickname, "Ana", "link antigo mudou");
      eq(
        (await ler(b.token)).players[0].nickname,
        "Beto",
        "link novo com retrato velho",
      );
      eq((await criar(H, S)).token, b.token);
    },
  );

  await t(
    "partida encerrada ANTES da migration: retrato no 1º pedido, só com quem estava antes do fim",
    async () => {
      const S = await novaSala({
        legado: true,
        jogadores: [{ nick: "Velha", score: 7, user: H }],
      });
      eq(await linhas(S), 0);
      const a = await criar(H, S);
      ok(a.ok, JSON.stringify(a));
      eq(
        (await ler(a.token)).players.map((p) => p.nickname),
        ["Velha"],
      );
    },
  );

  await t(
    "o gatilho NUNCA trava o fim do jogo (retrato com erro = jogo termina; link indisponível)",
    async () => {
      const S = await novaSala({
        fim: "nenhum",
        jogadores: [{ nick: "A", score: 1, user: H }],
      });
      await db.exec("BEGIN");
      try {
        await db.exec(`CREATE OR REPLACE FUNCTION public.match_share_snapshot(p_room_id uuid, p_fin timestamptz)
        RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha simulada'; END $$`);
        await db.q(
          `UPDATE public.rooms SET status = 'finished' WHERE id = $1`,
          [S],
        );
        eq(
          (await db.q(`SELECT status FROM public.rooms WHERE id = $1`, [S]))[0]
            .status,
          "finished",
          "o jogo não terminou",
        );
        eq(await linhas(S), 0);
      } finally {
        await db.exec("ROLLBACK"); // desfaz a função quebrada (e o fim simulado)
      }
    },
  );

  await t("retrato congelado; sala APAGADA continua visível", async () => {
    await db.q(
      `UPDATE public.players SET score = 999 WHERE room_id = $1 AND nickname = 'Bia'`,
      [SALA],
    );
    eq((await ler(TOKEN)).players[0].nickname, "Zé", "retrato mudou");
    await db.q(`DELETE FROM public.rooms WHERE id = $1`, [SALA]);
    ok((await ler(TOKEN))?.players?.length === 3, "sumiu com a sala apagada");
  });

  await t(
    "inválido, inexistente e vencido: MESMA resposta (null); anon não enumera; vencido não reabre",
    async () => {
      for (const bad of [
        "",
        "x",
        "' OR 1=1 --",
        TOKEN.toUpperCase(),
        TOKEN + "0",
        "0".repeat(32),
        randomUUID().replaceAll("-", ""),
      ])
        eq(await ler(bad), null, `token ${JSON.stringify(bad)}`);
      ok(
        await negado("anon", `SELECT token FROM public.match_shares`),
        "anon listou tokens",
      );
      const S = await novaSala({
        jogadores: [{ nick: "Ana", score: 5, user: H }],
      });
      const a = await criar(H, S);
      await db.q(
        `UPDATE public.match_shares SET expires_at = now() - interval '1 second' WHERE token = $1`,
        [a.token],
      );
      eq(await ler(a.token), null, "vencido ainda aparece");
      eq(await criar(H, S), { ok: false, reason: "expired" });
    },
  );

  await t(
    "validade = 30 dias depois do FIM da partida (= retenção da sala)",
    async () => {
      const S = await novaSala({
        jogadores: [{ nick: "Leo", score: 1, user: C }],
      });
      const [{ d }] = await db.q(
        `SELECT extract(epoch FROM s.expires_at - r.finished_at)::int AS d FROM public.match_shares s JOIN public.rooms r ON r.id = s.room_id WHERE s.room_id = $1`,
        [S],
      );
      eq(d, 30 * 86400);
    },
  );

  await t("limpeza remove só os vencidos", async () => {
    const S = await novaSala({
      jogadores: [{ nick: "Leo", score: 1, user: C }],
    });
    const vivo = await criar(C, S);
    await db.q(`SELECT public.match_shares_cleanup()`);
    eq(
      (
        await db.q(
          `SELECT count(*)::int AS n FROM public.match_shares WHERE expires_at <= now()`,
        )
      )[0].n,
      0,
    );
    ok(await ler(vivo.token), "limpeza apagou link válido");
  });

  await t(
    "conta apagada (exclusão ou limpeza de convidado): os links em que ela jogou somem",
    async () => {
      const U = await novoUsuario();
      const S = await novaSala({
        jogadores: [
          { nick: "Some", score: 4, user: U },
          { nick: "Fica", score: 2, user: C },
        ],
      });
      const s = await criar(U, S);
      ok(await ler(s.token));
      await db.q(`DELETE FROM auth.users WHERE id = $1`, [U]);
      eq(await ler(s.token), null);
    },
  );

  if (!modePg) {
    await t(
      "rollback: aplica limpo (gatilhos saem), o jogo termina sem eles e a migration reaplica",
      async () => {
        await db.exec(ROLLBACK);
        eq(
          (
            await db.q(
              `SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE '%match_share%'`,
            )
          )[0].n,
          0,
        );
        eq(
          (
            await db.q(
              `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('match_share_on_finish','match_shares_forget_user')`,
            )
          )[0].n,
          0,
        );
        const S = await novaSala({
          jogadores: [{ nick: "Sem", score: 1, user: H }],
        });
        eq(
          (await db.q(`SELECT status FROM public.rooms WHERE id = $1`, [S]))[0]
            .status,
          "finished",
        );
        await db.exec(MIG);
        ok(
          (await db.q(`SELECT to_regclass('public.match_shares') AS r`))[0].r,
          "não reaplicou",
        );
      },
    );
  }
} finally {
  if (modePg) {
    await db
      .q(`DELETE FROM public.match_shares WHERE room_id = ANY($1::uuid[])`, [
        salas,
      ])
      .catch(() => {});
    await db.q(`DELETE FROM public.rooms WHERE id = ANY($1::uuid[])`, [salas]);
    await db.q(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [usuarios]);
  }
  await db.close();
}

console.log(`\n${pass} ok, ${fail} falha(s)`);
if (fail) {
  console.log("FALHAS:\n - " + falhas.join("\n - "));
  process.exit(1);
}
console.log("RESULTADO COMPARTILHADO OK");
