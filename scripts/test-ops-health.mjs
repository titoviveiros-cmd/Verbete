// M1 · Lotes F/H — sinais de saúde que significam algo + controle remoto.
//   • tick conta só transições REAIS (o ruído de 43.200 eventos/mês acaba);
//   • erro numa sala não derruba o tick (vira tick_error) e há heartbeat;
//   • ops_health_check alerta (IA falhando, cron parado, tick com erro,
//     salas paradas), sem duplicar e com webhook opcional;
//   • get_client_config expõe só as chaves client.*;
//   • o script de manutenção (cleanup v2) faz o que promete — aplicado só
//     neste banco efêmero e restaurado ao fim.
// Envs: SUPA_URL, ANON, DB_URL.
import pg from "pg";
import { readFileSync } from "node:fs";

const { SUPA_URL, ANON, DB_URL } = process.env;
const db = new pg.Client({
  connectionString: DB_URL,
  ssl: /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false,
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
const tag = Math.random().toString(36).slice(2, 7);
const rooms = [];

async function mkRoom(status, extra = {}) {
  const code = `O${tag}${rooms.length + 1}`; // rooms.code é UNIQUE
  const r = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, created_at, phase_started_at,
                               round_phase_ends_at, categories, nivel, mode, teams, current_word_id)
     VALUES ($1, $2, $3, 1, COALESCE($4, now()), $5, $6, COALESCE($7, '{}'::text[]),
             COALESCE($8, 'aleatorio'), COALESCE($9, 'individual'), COALESCE($10::jsonb, '[]'::jsonb), $11)
     RETURNING id`,
    [
      code, `ops_h_${tag}`, status, extra.created_at ?? null, extra.phase_started_at ?? null,
      extra.ends ?? null, extra.categories ?? null, extra.nivel ?? null, extra.mode ?? null,
      extra.teams ?? null, extra.word ?? null,
    ],
  );
  rooms.push(r.id);
  if (extra.human !== false) {
    await db.query(
      `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot, joined_at)
       VALUES ($1, $2, 'H', 'h', '#000', false, COALESCE($3, now()))`,
      [`ops_p_${tag}_${rooms.length}`, r.id, extra.joined_at ?? null],
    );
  }
  return r.id;
}
const statusOf = async (id) => (await row(`SELECT status FROM public.rooms WHERE id = $1`, [id])).status;

// ---------------------------------------------------------------------------
console.log("— tick: só transições reais contam");
const zombie = await mkRoom("choosing", {
  ends: new Date(Date.now() - 60_000).toISOString(),
  phase_started_at: new Date(Date.now() - 40 * 60_000).toISOString(),
});
// Sem palavra elegível (get_random_words cai em qualquer palavra publicada
// quando o filtro esvazia — só esgota com TODAS já usadas): o avanço vira
// noop_no_words e só rearma o prazo, o ciclo das salas-zumbi de julho.
await db.query(
  `UPDATE public.rooms SET used_word_ids = (SELECT array_agg(id) FROM public.words) WHERE id = $1`,
  [zombie],
);
const t1 = (await row(`SELECT public.tick_stalled_rooms() AS t`)).t;
check("sala-zumbi sem palavra elegível continua em choosing", (await statusOf(zombie)) === "choosing");
check(
  "e NÃO é contada como avanço",
  !(t1.advanced > 0 && (await row(
    `SELECT payload FROM public.ops_events WHERE kind = 'stalled_advance' ORDER BY at DESC LIMIT 1`,
  ))?.payload?.by_phase?.choosing > 0),
  short(t1),
);
const hb = await row(`SELECT at, payload FROM public.ops_heartbeat WHERE job = 'tick_stalled_rooms'`);
check("heartbeat do tick gravado", !!hb && Date.now() - new Date(hb.at).getTime() < 60_000, short(hb));

const { id: wordId } = await row(`SELECT id FROM public.words WHERE meaning IS NOT NULL LIMIT 1`);
const stuck = await mkRoom("writing", {
  word: wordId,
  ends: new Date(Date.now() - 60_000).toISOString(),
  phase_started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  human: false,
});
const t2 = (await row(`SELECT public.tick_stalled_rooms() AS t`)).t;
check(
  "sala de escrita vencida e sem pendentes avança e conta como avanço real",
  (await statusOf(stuck)) === "voting" && t2.advanced >= 1,
  short(t2),
);

console.log("\n— tick: erro numa sala não derruba as outras");
const broken = await mkRoom("scoreboard", {
  mode: "teams",
  teams: JSON.stringify("nao-e-lista"),
  ends: new Date(Date.now() - 60_000).toISOString(),
});
const healthyLobbyHostless = await mkRoom("lobby", { human: true });
await db.query(`UPDATE public.rooms SET host_id = 'ausente_${tag}' WHERE id = $1`, [healthyLobbyHostless]);
const t3 = (await row(`SELECT public.tick_stalled_rooms() AS t`)).t;
check("o tick conclui e reporta o erro", t3.errors >= 1, short(t3));
const tickErr = await row(
  `SELECT payload FROM public.ops_events WHERE kind = 'tick_error' ORDER BY at DESC LIMIT 1`,
);
check("evento tick_error registrado com o motivo", /scoreboard/.test(tickErr?.payload?.first ?? ""), short(tickErr));
const heir = await row(`SELECT host_id FROM public.rooms WHERE id = $1`, [healthyLobbyHostless]);
check(
  "no mesmo tick, sala sem host recebe o herdeiro (backstop de migrate_host)",
  heir.host_id === `ops_p_${tag}_${rooms.length}`,
  heir.host_id,
);

// ---------------------------------------------------------------------------
console.log("\n— ops_health_check: alertas mínimos");
await db.query(`DELETE FROM public.ops_alerts`);
for (let i = 0; i < 6; i++) {
  await db.query(
    `INSERT INTO public.ops_events (kind, payload) VALUES ('bot_ai_error', '{"fn":"bot-definitions","reason":"exception"}')`,
  );
}
let h = (await row(`SELECT public.ops_health_check() AS h`)).h;
const kinds = async () =>
  (await db.query(`SELECT kind FROM public.ops_alerts ORDER BY kind`)).rows.map((x) => x.kind);
check("IA falhando (6 erros, 0 sucesso) gera alerta ai_errors", (await kinds()).includes("ai_errors"), short(h));
check("tick com erro gera alerta tick_errors", (await kinds()).includes("tick_errors"), short(h.fired));
h = (await row(`SELECT public.ops_health_check() AS h`)).h;
const dup = await row(`SELECT count(*)::int AS n FROM public.ops_alerts WHERE kind = 'ai_errors'`);
check("o mesmo alerta não se repete dentro de 60 min", dup.n === 1, `n=${dup.n}`);

await db.query("BEGIN");
await db.query(
  `UPDATE public.ops_heartbeat SET at = now() - interval '10 minutes' WHERE job = 'tick_stalled_rooms'`,
);
h = (await row(`SELECT public.ops_health_check() AS h`)).h;
await db.query("COMMIT");
check("cron sem heartbeat há 10 min gera alerta crítico cron_stalled", (await kinds()).includes("cron_stalled"), short(h.fired));

for (let i = 0; i < 3; i++) {
  await mkRoom("voting", {
    created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
    phase_started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    ends: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
}
h = (await row(`SELECT public.ops_health_check() AS h`)).h;
check("3 salas com jogadores paradas há 15+ min geram stuck_rooms", (await kinds()).includes("stuck_rooms"), short(h.metrics));

await db.query(
  `INSERT INTO public.app_config (key, value) VALUES ('ops_alert_webhook_url', 'https://example.invalid/hook')
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
);
await row(`SELECT public.ops_health_check() AS h`);
const pend = await row(`SELECT count(*)::int AS n FROM public.ops_alerts WHERE notified_at IS NULL`);
check("com webhook configurado, os alertas são despachados (notified_at)", pend.n === 0, `pendentes=${pend.n}`);
await db.query(`DELETE FROM public.app_config WHERE key = 'ops_alert_webhook_url'`);

const cron = await row(`SELECT count(*)::int AS n FROM cron.job WHERE jobname = 'verbete-ops-health'`);
check("checagem agendada no pg_cron (a cada 5 min)", cron.n === 1);

// ---------------------------------------------------------------------------
console.log("\n— get_client_config (versão mínima / manutenção remotas)");
await db.query(
  `INSERT INTO public.app_config (key, value) VALUES
     ('client.min_native_build', '3'), ('client.maintenance', 'off'),
     ('ops_heartbeat_ping_url', 'https://example.invalid/ping')
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
);
const cfgRes = await fetch(`${SUPA_URL}/rest/v1/rpc/get_client_config`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
  body: "{}",
});
const cfg = await cfgRes.json();
check(
  "a API pública lê só as chaves client.* (sem prefixo)",
  cfg?.min_native_build === "3" && cfg?.maintenance === "off",
  short(cfg),
);
check(
  "chaves internas (webhook/ping/anon key do pg_net) NÃO aparecem",
  !JSON.stringify(cfg).includes("example.invalid") && !("supabase_anon_key" in (cfg ?? {})),
  short(Object.keys(cfg ?? {})),
);
const direct = await fetch(`${SUPA_URL}/rest/v1/app_config?select=*`, {
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
});
const directBody = await direct.text();
check("a tabela app_config segue fechada para a API", direct.status >= 400 || directBody === "[]", `HTTP ${direct.status}`);
await db.query(
  `DELETE FROM public.app_config WHERE key IN ('client.min_native_build','client.maintenance','ops_heartbeat_ping_url')`,
);

// ---------------------------------------------------------------------------
console.log("\n— Manutenção separada: cleanup_zombie_rooms v2 (aplicada só aqui)");
const original = (await row(
  `SELECT pg_get_functiondef('public.cleanup_zombie_rooms()'::regprocedure) AS def`,
)).def;
try {
  await db.query(readFileSync("supabase/maintenance/20261003_cleanup_zombie_rooms_v2.sql", "utf8"));
  const rearmed = await mkRoom("choosing", {
    created_at: new Date(Date.now() - 50 * 60_000).toISOString(),
    phase_started_at: new Date(Date.now() - 40 * 60_000).toISOString(),
    ends: new Date(Date.now() + 50_000).toISOString(), // prazo "rearmado" pelo tick
  });
  const lobbyAtivo = await mkRoom("lobby", {
    created_at: new Date(Date.now() - 45 * 60_000).toISOString(),
    joined_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  const lobbyMorto = await mkRoom("lobby", {
    created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    joined_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
  });
  const res = (await row(`SELECT public.cleanup_zombie_rooms() AS r`)).r;
  check("sala com prazo rearmado mas fase parada há 40 min é encerrada", (await statusOf(rearmed)) === "finished", short(res));
  check("lobby criado há 45 min com gente entrando há 5 min NÃO é encerrado", (await statusOf(lobbyAtivo)) === "lobby");
  check("lobby sem atividade há 2 h é encerrado", (await statusOf(lobbyMorto)) === "finished");
} finally {
  await db.query(original);
}

// ---------------------------------------------------------------------------
await db.query(`DELETE FROM public.rooms WHERE id = ANY($1)`, [rooms]);
await db.query(`DELETE FROM public.players WHERE id LIKE $1`, [`ops_p_${tag}_%`]);
await db.query(`DELETE FROM public.ops_alerts`);
await db.query(`DELETE FROM public.ops_events WHERE kind IN ('bot_ai_error','tick_error')`);
await db.end();
console.log(fails ? `\n${fails}/${total} FALHAS` : `\nSAÚDE/ALERTAS OK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
