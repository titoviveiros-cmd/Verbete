// Roda TODAS as suítes de integração (Supabase local do CI) e só falha no
// fim, com o resumo — uma falha não esconde as demais.
// test-semantic-calibration fica de fora: depende da chave real do Gemini
// (test-edges-e2e cobre o mesmo caminho com um Gemini simulado).
// ci-android.mjs (Gradle) roda à parte, no job `android` da CI, em paralelo.
import { spawnSync } from "node:child_process";

const SUITES = [
  "ci-deno-check.mjs",
  "test-identity.mjs",
  "test-e2e-round.mjs",
  "test-match-sem-ia.mjs", // partida completa com ai_mode=suspenso, sem edges servidas (08/11/2026)
  "test-security-rest.mjs",
  "test-rooms-leitura.mjs", // salas: leitura só de participantes; enumeração, código exato (vc8), Realtime, entradas simultâneas (12/11/2026)
  "test-privacidade-fase2.mjs", // players e tabelas ligadas só de participantes, RPCs por id, canais Realtime PRIVADOS (12/11/2026)
  "test-shuffling-deadlock.mjs",
  "test-similarity-bonus.mjs",
  "test-daily-guard.mjs", // V2 Diário: reserva atômica antes da IA, com conexões REAIS independentes
  "test-match-share.mjs", // resultado compartilhado: retrato do servidor, token aleatório, validade (09/11/2026)
  "test-autorizacao-fase3.mjs", // RPCs de partida só de participantes ativos; coordenador/host onde o jogo exige; sem oráculo (13/11/2026)
  "test-daily-choice.mjs", // Diário D1 (modo escolha, sem IA): uma tentativa por hora nos 2 modos, relógio do servidor, sequência, placar (08/11/2026)
  "test-daily-choice-hash.mjs", // D1 R1/R2/R3 no banco: hash conferido no UPDATE, trava de aprovado, corridas reais (10/11/2026)
  "test-daily-choice-r6b.mjs", // D1 R6b no banco: a função antiga não aprova (só por hash), rollback byte a byte, corrida real (10/11/2026)
  "test-v3-quota-sql.mjs", // V3 edges: cota dos bots no banco (depois da V2, que recria as funções dela)
  "test-edges-e2e.mjs",
  "test-phase-secs.mjs",
  "test-ops.mjs",
  "test-ops-health.mjs",
  "test-ranking-optin.mjs", // B6 ECA Digital: ranking só com opt-in, leitura de profiles, vc8 e rollback (11/11/2026)
  "test-r4-anti-loop.mjs",
  "test-p2-xp.mjs",
  "test-player-id.mjs",
  "test-seguranca-lancamento.mjs", // código de sala sem colisão (corrida real) + teto do log_ops_event + chat dormente fechado (10/11/2026)
  "test-limite-codigo-sala.mjs", // ECA R6: limite de tentativas de código de sala por identidade, registro com hash, corrida real (12/11/2026)
  "test-limite-salas.mjs", // teto de salas por jogador (vivas/hora/dia, corrida, ataque × legítimos) + código liberado das salas limpas (11/11/2026)
  "test-pause-resume.mjs",
  "test-bot-votes.mjs",
  "test-sala-trancada.mjs", // ECA Digital B4: sala trancada pelo dono, expulso não volta, partida rápida fechada (11/11/2026)
  "test-native-auth-callback.mjs",
  "test-data-retention.mjs",
  "test-definition-filter.mjs",
  "test-ugc-filtro.mjs", // ECA Digital: palavrão/link/contato barrados no servidor (definição, apelido, nome exibido) (11/11/2026)
  "test-near-miss.mjs",
  "test-rollback.mjs",
  "test-denuncia-recurso.mjs", // ECA Digital: decisão fundamentada, recurso 1 por denúncia, tabela fechada ao cliente (11/11/2026)
  "test-probe-local.mjs",
];

// Nenhuma suíte pode deixar o pg_cron do banco LOCAL diferente do início (20/11/2026:
// test-ugc-filtro pausa os jobs durante a suíte). Foto antes, conferência no fim.
// Compara nome, agenda, banco, usuário, estado e comando de TODOS os jobs (21/11: antes só os
// ativos), não o jobid: suítes que reaplicam migration/rollback
// recriam jobs com o mesmo nome e id novo (CI de 20/11: job 6 → 12, mesmo job).
const localDb =
  process.env.DB_URL &&
  !/supabase\.co/.test(process.env.DB_URL) &&
  /@(127\.0\.0\.1|localhost)(:|\/)/.test(process.env.DB_URL);
const cronAtivos = async () => {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.DB_URL });
  await c.connect();
  try {
    return (
      await c.query(
        // Todos os jobs (ativos ou não): nome@agenda, banco/usuário, estado e md5 do comando.
        "SELECT coalesce(string_agg(coalesce(jobname, '#' || jobid) || '@' || schedule || ' ' || database || '/' || username || ' ' || CASE WHEN active THEN 'ativo' ELSE 'inativo' END || ' cmd:' || left(md5(command), 8), ', ' ORDER BY coalesce(jobname, '#' || jobid)), '') j FROM cron.job",
      )
    ).rows[0].j;
  } finally {
    await c.end();
  }
};
let cronAntes = null;
if (localDb) cronAntes = await cronAtivos().catch(() => null);

const results = [];
for (const s of SUITES) {
  console.log(`\n━━━━━━━━ ${s} ━━━━━━━━`);
  const r = spawnSync(process.execPath, [`scripts/${s}`], { stdio: "inherit", env: process.env });
  results.push({ s, ok: r.status === 0 });
}
if (cronAntes !== null) {
  const depois = await cronAtivos().catch((e) => `erro: ${e.message}`);
  const n = cronAntes ? cronAntes.split(", ").length : 0;
  results.push({
    s: `pg_cron igual ao início (${n} job(s): nome, agenda, banco, usuário, estado e comando)`,
    ok: depois === cronAntes,
  });
  if (depois !== cronAntes) console.log(`❌ pg_cron mudou: antes [${cronAntes}] depois [${depois}]`);
}
console.log("\n━━━━━━━━ RESUMO ━━━━━━━━");
for (const { s, ok } of results) console.log(`${ok ? "✅" : "❌"} ${s}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} suíte(s) falharam` : `\n${results.length}/${results.length} suítes OK`);
process.exit(failed ? 1 : 0);
