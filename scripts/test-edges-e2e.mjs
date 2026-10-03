// IA de ponta a ponta: as DUAS edge functions servidas de verdade (Deno)
// contra o Supabase local do CI, com um Gemini simulado.
//   • bot-definitions: geração normal, anti-vazamento da verdade e a memória
//     por rodada — o caminho exato que o `norm` inexistente derrubava em
//     produção (27/07–02/10) — com os eventos bot_ai_*;
//   • score-similarity (bônus 🧠): +3 e near_truth só na rodada já pontuada,
//     texto do chamador ignorado, verdade fora das candidatas, replay sem
//     somar, falha do Gemini sem bônus e com evento — e a CADEIA COMPLETA de
//     produção: advance_voting_to_reveal → pg_net → edge → apply_similarity_bonus.
// Envs: SUPA_URL, ANON, DB_URL (a chave de serviço LOCAL vem do `supabase status`).
import http from "node:http";
import { execSync, spawn } from "node:child_process";
import pg from "pg";

const { SUPA_URL, ANON, DB_URL } = process.env;
const SERVICE =
  process.env.SERVICE_ROLE_KEY ??
  execSync("npx supabase status -o env", { encoding: "utf8" }).match(
    /^SERVICE_ROLE_KEY="?([^"\n]+)"?$/m,
  )?.[1];
if (!SERVICE) {
  console.log("❌ sem SERVICE_ROLE_KEY local (supabase status)");
  process.exit(1);
}

const db = new pg.Client({
  connectionString: DB_URL,
  ssl: /supabase\.co/.test(DB_URL ?? "")
    ? { rejectUnauthorized: false }
    : false,
});
await db.connect();
let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const row = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const short = (x) => JSON.stringify(x ?? null).slice(0, 160);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);

// ---------------------------------------------------------------- Gemini simulado
const calls = [];
let stubMode = "ok";
let botDefs = [];
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* corpo inválido: responde mesmo assim */
    }
    calls.push(body);
    if (stubMode === "503") {
      res.writeHead(503);
      res.end("overloaded");
      return;
    }
    const sys = String(body?.messages?.[0]?.content ?? "");
    const user = String(body?.messages?.[1]?.content ?? "");
    let content;
    if (/lexic[oó]grafo/i.test(sys)) {
      content = JSON.stringify({ definitions: botDefs });
    } else {
      // juiz: aprova as candidatas cujo texto REAL contém "QUASE"
      const ids = [...user.matchAll(/\[id=([^\]]+)\] "([^"]*)"/g)]
        .filter((m) => /quase/i.test(m[2]))
        .map((m) => m[1]);
      content = JSON.stringify({ matches: ids });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => stub.listen(54999, "0.0.0.0", r));

// ---------------------------------------------------------------- edge via Deno
async function serveEdge(name) {
  const child = spawn(
    "npx",
    ["--yes", "deno@2", "run", "-A", `supabase/functions/${name}/index.ts`],
    {
      env: {
        ...process.env,
        SUPABASE_URL: SUPA_URL,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE,
        GEMINI_API_KEY: "stub",
        GEMINI_CHAT_URL: "http://127.0.0.1:54999/chat",
      },
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    },
  );
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8000/", { method: "OPTIONS" });
      if (r.status === 200) return child;
    } catch {
      /* ainda subindo */
    }
    await sleep(500);
  }
  throw new Error(`${name} não subiu em 120 s`);
}
async function stopEdge(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* já saiu */
  }
  await sleep(1500);
}
const callEdge = async (body) => {
  const r = await fetch("http://127.0.0.1:8000/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const lastEvent = async (kindLike, afterId) =>
  row(
    `SELECT kind, payload FROM public.ops_events WHERE kind LIKE $1 AND id > $2 ORDER BY id DESC LIMIT 1`,
    [kindLike, afterId],
  );

// Pré-voo: a chave de serviço local abre a API REST? (sem imprimir a chave)
const keyKind = (() => {
  const p = SERVICE.split(".");
  if (p.length !== 3) return SERVICE.slice(0, 10) + "…";
  try {
    return (
      "jwt role=" + JSON.parse(Buffer.from(p[1], "base64url").toString()).role
    );
  } catch {
    return "jwt ilegível";
  }
})();
const pre = await fetch(`${SUPA_URL}/rest/v1/rounds?select=room_id&limit=1`, {
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
});
check(
  "pré-voo: a chave de serviço local lê o banco pela API",
  pre.status === 200,
  `${keyKind} HTTP ${pre.status} ${(await pre.text()).slice(0, 120)}`,
);

const {
  rows: [w],
} = await db.query(
  `SELECT id, meaning FROM public.words
    WHERE status = 'published' AND meaning IS NOT NULL AND char_length(meaning) BETWEEN 15 AND 200
    LIMIT 1`,
);
const baseEvent = (
  await row(`SELECT COALESCE(max(id), 0) AS id FROM public.ops_events`)
).id;
const rooms = [];
const mkRoom = async (status, round = 1) => {
  const r = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, current_word_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`E${tag}${rooms.length}`, `edge_h_${tag}`, status, round, w.id],
  );
  rooms.push(r.id);
  return r.id;
};

try {
  // ================================================================ bot-definitions
  console.log("— bot-definitions (IA dos bots) servida de verdade");
  let edge = await serveEdge("bot-definitions");
  try {
    const rid = await mkRoom("writing");
    botDefs = [
      "utensilio de ferro usado para moer graos",
      "danca de roda tipica do litoral",
      w.meaning,
    ];

    let r = await callEdge({ word_id: w.id, count: 3, room_id: rid, round: 1 });
    const defs = r.json?.definitions ?? [];
    check(
      "gera definições pela IA (sem cair no fallback de templates)",
      r.status === 200 && defs.length === 2 && !r.json?.error,
      short(r.json),
    );
    check(
      "candidata igual à verdade é descartada (anti-vazamento)",
      !defs.includes(w.meaning),
    );
    const served = await row(
      `SELECT count(*)::int AS n FROM public.ai_served_defs WHERE room_id = $1 AND round = 1`,
      [rid],
    );
    check(
      "memória da rodada gravada (caminho do bug norm/normTxt)",
      served.n === 2,
      `n=${served.n}`,
    );
    let ev = await lastEvent("bot_ai_%", baseEvent);
    check(
      "evento bot_ai_success com o descarte registrado, sem texto",
      ev?.kind === "bot_ai_success" &&
        ev.payload.dropped_leak === 1 &&
        !JSON.stringify(ev.payload).includes("moer"),
      short(ev),
    );

    r = await callEdge({ word_id: w.id, count: 3, room_id: rid, round: 1 });
    check(
      "a mesma sugestão nunca é servida duas vezes na rodada (memória)",
      r.status === 200 && (r.json?.definitions ?? []).length === 0,
      short(r.json),
    );
    ev = await lastEvent("bot_ai_%", baseEvent);
    check(
      "e isso vira bot_ai_fallback (all_filtered), não erro",
      ev?.kind === "bot_ai_fallback" &&
        ev.payload.reason === "all_filtered" &&
        ev.payload.dropped_served === 2,
      short(ev),
    );

    const other = await row(
      `SELECT id FROM public.words WHERE id <> $1 LIMIT 1`,
      [w.id],
    );
    r = await callEdge({ word_id: other.id, count: 2, room_id: rid, round: 1 });
    check(
      "palavra fora de rodada ativa → 403 (sem chamar a IA)",
      r.status === 403,
      `HTTP ${r.status}`,
    );

    stubMode = "503";
    const before = calls.length;
    r = await callEdge({ word_id: w.id, count: 2, room_id: rid, round: 2 });
    stubMode = "ok";
    ev = await lastEvent("bot_ai_%", baseEvent);
    check(
      "Gemini fora: nova tentativa, resposta vazia e evento bot_ai_error",
      r.json?.error === "ai_failed" &&
        calls.length - before === 2 &&
        ev?.kind === "bot_ai_error" &&
        ev.payload.status === 503,
      `${short(r.json)} tentativas=${calls.length - before} ${short(ev)}`,
    );

    const junkFrom = (
      await row(`SELECT COALESCE(max(id), 0) AS id FROM public.ops_events`)
    ).id;
    const junk = await fetch("http://127.0.0.1:8000/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "lixo",
    });
    r = await callEdge({ word_id: "w1", count: 2 });
    const junkEv = await lastEvent("bot_ai_%", junkFrom);
    check(
      "pedido malformado (JSON inválido, id não-UUID) → 400, sem evento de erro de IA",
      junk.status === 400 && r.status === 400 && !junkEv,
      `HTTP ${junk.status}/${r.status} ${short(junkEv)}`,
    );
  } finally {
    await stopEdge(edge);
  }

  // ================================================================ score-similarity
  console.log("\n— score-similarity (bônus 🧠) servida de verdade");
  edge = await serveEdge("score-similarity");
  try {
    const P_NEAR = `edge_n_${tag}`;
    const P_FAR = `edge_f_${tag}`;
    const mkRound = async (status, withRound, nearPid, farPid) => {
      const rid = await mkRoom(status);
      await db.query(
        `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot) VALUES
       ($1, $3, 'Near', 'n', '#000', false), ($2, $3, 'Far', 'f', '#000', false)`,
        [nearPid, farPid, rid],
      );
      const { rows: d } = await db.query(
        `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth) VALUES
       ($1, 1, '__truth__', 'fruto seco do cerrado', true),
       ($1, 1, $2, 'QUASE: fruto seco do cerrado brasileiro', false),
       ($1, 1, $3, 'ferramenta de sapateiro', false)
       RETURNING id, player_id`,
        [rid, nearPid, farPid],
      );
      if (withRound) {
        await db.query(
          `INSERT INTO public.rounds (room_id, round, coordinator_id, word_id) VALUES ($1, 1, $2, $3)`,
          [rid, farPid, w.id],
        );
      }
      const by = Object.fromEntries(d.map((x) => [x.player_id, x.id]));
      return { rid, truth: by.__truth__, near: by[nearPid], far: by[farPid] };
    };
    const score = async (pid) =>
      (await row(`SELECT score FROM public.players WHERE id = $1`, [pid]))
        .score;

    const a = await mkRound("reveal", true, P_NEAR, P_FAR);
    let r = await callEdge({
      room_id: a.rid,
      round: 1,
      candidates: [
        { id: a.near, text: "texto forjado pelo chamador" },
        { id: a.far, text: "QUASE forjado: o juiz não pode ler isto" },
        { id: a.truth, text: "verdade" },
      ],
    });
    const near = await row(
      `SELECT near_truth FROM public.definitions WHERE id = $1`,
      [a.near],
    );
    check(
      "bônus aplicado: +3 e near_truth no blefe próximo da verdade",
      short(r.json?.matches) === short([a.near]) &&
        (await score(P_NEAR)) === 3 &&
        near.near_truth === true,
      `${short(r.json)} near=${await score(P_NEAR)}`,
    );
    check("blefe distante não ganha nada", (await score(P_FAR)) === 0);
    const judged = String(calls.at(-1)?.messages?.[1]?.content ?? "");
    check(
      "o juiz recebe os textos REAIS do banco (o do chamador é ignorado)",
      judged.includes("QUASE: fruto seco do cerrado brasileiro") &&
        !judged.includes("forjado"),
    );
    check(
      "a definição verdadeira nunca entra como candidata",
      !judged.includes(`[id=${a.truth}]`),
    );

    r = await callEdge({
      room_id: a.rid,
      round: 1,
      candidates: [{ id: a.near }],
    });
    check(
      "replay não soma de novo (idempotente)",
      (await score(P_NEAR)) === 3,
      short(r.json),
    );
    let ev = await lastEvent("judge_ai_%", baseEvent);
    check(
      "evento judge_ai_success registrado",
      ev?.kind === "judge_ai_success",
      short(ev),
    );

    const b = await mkRound(
      "voting",
      false,
      `edge_n2_${tag}`,
      `edge_f2_${tag}`,
    );
    const callsBefore = calls.length;
    r = await callEdge({
      room_id: b.rid,
      round: 1,
      candidates: [{ id: b.near }, { id: b.truth }],
    });
    check(
      "durante a votação (rodada não pontuada) não julga nem chama a IA — sem oráculo",
      r.json?.error === "round_not_scored" && calls.length === callsBefore,
      short(r.json),
    );

    const c = await mkRound("reveal", true, `edge_n3_${tag}`, `edge_f3_${tag}`);
    stubMode = "503";
    r = await callEdge({
      room_id: c.rid,
      round: 1,
      candidates: [{ id: c.near }],
    });
    stubMode = "ok";
    ev = await lastEvent("judge_ai_%", baseEvent);
    check(
      "Gemini fora: sem bônus, nova tentativa e evento judge_ai_error",
      r.json?.error === "ai_503" &&
        (await score(`edge_n3_${tag}`)) === 0 &&
        ev?.kind === "judge_ai_error" &&
        ev.payload.attempts === 2,
      `${short(r.json)} ${short(ev)}`,
    );

    const junkFrom = (
      await row(`SELECT COALESCE(max(id), 0) AS id FROM public.ops_events`)
    ).id;
    const junkCalls = calls.length;
    r = await callEdge({ room_id: "lixo", round: 1, candidates: [{ id: "x" }] });
    const junk = await fetch("http://127.0.0.1:8000/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "lixo",
    });
    const junkBody = await junk.json().catch(() => null);
    const junkEv = await lastEvent("judge_ai_%", junkFrom);
    check(
      "pedido malformado → nada julgado, IA não chamada, sem evento de erro",
      short(r.json) === short({ matches: [] }) &&
        short(junkBody) === short({ matches: [] }) &&
        calls.length === junkCalls &&
        !junkEv,
      `${short(r.json)} ${short(junkBody)} ${short(junkEv)}`,
    );

    // ----- cadeia completa de produção: fim da votação → pg_net → edge
    const gw = (await row(`SELECT host(inet_server_addr()) AS ip`)).ip.replace(
      /\.\d+$/,
      ".1",
    );
    await db.query(
      `INSERT INTO public.app_config (key, value) VALUES ('supabase_url', $1), ('supabase_anon_key', $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`http://${gw}:8000`, ANON],
    );
    try {
      const V = `edge_v_${tag}`;
      const N = `edge_w_${tag}`;
      const C = `edge_c_${tag}`;
      const rid = await mkRoom("voting");
      await db.query(
        `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, joined_at) VALUES
       ($1, $4, 'Votante', 'v', '#000', false, now() - interval '10 minutes'),
       ($2, $4, 'Escritor', 'w', '#000', false, now() - interval '10 minutes'),
       ($3, $4, 'Coordenador', 'c', '#000', false, now() - interval '10 minutes')`,
        [V, N, C, rid],
      );
      const { rows: d } = await db.query(
        `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth, letter) VALUES
       ($1, 1, '__truth__', 'fruto seco do cerrado', true, 'A'),
       ($1, 1, $2, 'QUASE: fruto seco tipico do cerrado', false, 'B')
       RETURNING id, player_id`,
        [rid, N],
      );
      const truthId = d.find((x) => x.player_id === "__truth__").id;
      await db.query(
        `INSERT INTO public.votes (room_id, round, voter_id, definition_id) VALUES ($1, 1, $2, $4), ($1, 1, $3, $4)`,
        [rid, V, N, truthId],
      );
      // prazo vencido só agora, com a sala completa (o cron pode correr junto —
      // tanto faz quem pontua: o UNIQUE de rounds impede pontuar duas vezes).
      // rounds.coordinator_id é NOT NULL: a sala precisa de coordenador.
      await db.query(
        `UPDATE public.rooms SET current_coordinator = $2, round_phase_ends_at = now() - interval '5 minutes' WHERE id = $1`,
        [rid, C],
      );
      await db.query(`SELECT public.advance_voting_to_reveal($1)`, [rid]);
      // o votante não tem blefe: fica em 3 (o escritor recebe o bônus assíncrono);
      // houve acerto da verdade, então o coordenador não ganha os +2
      check(
        "rodada pontuada pelo motor (+3 verdade para quem acertou; coordenador sem +2)",
        (await score(V)) === 3 && (await score(C)) === 0,
        `votante=${await score(V)} coordenador=${await score(C)}`,
      );
      let final = 0;
      for (let i = 0; i < 40 && final !== 6; i++) {
        await sleep(500);
        final = await score(N);
      }
      const resp = await row(
        `SELECT status_code, error_msg FROM net._http_response ORDER BY id DESC LIMIT 1`,
      ).catch(() => null);
      check(
        "cadeia completa: pg_net chama a edge e o bônus 🧠 entra (+3)",
        final === 6,
        `escritor=${final} gateway=${gw} pg_net=${short(resp)}`,
      );
    } finally {
      await db.query(
        `DELETE FROM public.app_config WHERE key IN ('supabase_url', 'supabase_anon_key')`,
      );
    }
  } finally {
    await stopEdge(edge);
  }

  // ---------------------------------------------------------------- privilégios
  const priv = await row(
    `SELECT has_function_privilege('service_role', 'public.apply_similarity_bonus(uuid,integer,uuid[])', 'EXECUTE') AS svc,
          has_function_privilege('anon', 'public.apply_similarity_bonus(uuid,integer,uuid[])', 'EXECUTE') AS anon,
          has_function_privilege('authenticated', 'public.apply_similarity_bonus(uuid,integer,uuid[])', 'EXECUTE') AS auth`,
  );
  check(
    "apply_similarity_bonus: só a chave de serviço executa",
    priv.svc && !priv.anon && !priv.auth,
    short(priv),
  );
} catch (e) {
  check(
    "a suíte roda até o fim sem exceção",
    false,
    String(e?.message ?? e).slice(0, 200),
  );
} finally {
  // Sem sobras: sala ativa largada aqui vira erro no tick das suítes seguintes.
  await db.query(`DELETE FROM public.rooms WHERE id = ANY($1)`, [rooms]);
  await db.query(`DELETE FROM public.players WHERE id LIKE $1`, [
    `edge_%_${tag}`,
  ]);
  stub.close();
}
await db.end();
console.log(
  fails
    ? `\n${fails}/${total} FALHAS`
    : `\nIA DE PONTA A PONTA OK — ${total}/${total}`,
);
process.exit(fails ? 1 : 0);
