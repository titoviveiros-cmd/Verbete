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
  "test-shuffling-deadlock.mjs",
  "test-similarity-bonus.mjs",
  "test-daily-guard.mjs", // V2 Diário: reserva atômica antes da IA, com conexões REAIS independentes
  "test-match-share.mjs", // resultado compartilhado: retrato do servidor, token aleatório, validade (09/11/2026)
  "test-daily-choice.mjs", // Diário D1 (modo escolha, sem IA): uma tentativa por hora nos 2 modos, relógio do servidor, sequência, placar (08/11/2026)
  "test-daily-choice-hash.mjs", // D1 R1/R2/R3 no banco: hash conferido no UPDATE, trava de aprovado, corridas reais (10/11/2026)
  "test-daily-choice-r6b.mjs", // D1 R6b no banco: a função antiga não aprova (só por hash), rollback byte a byte, corrida real (10/11/2026)
  "test-v3-quota-sql.mjs", // V3 edges: cota dos bots no banco (depois da V2, que recria as funções dela)
  "test-edges-e2e.mjs",
  "test-phase-secs.mjs",
  "test-ops.mjs",
  "test-ops-health.mjs",
  "test-r4-anti-loop.mjs",
  "test-p2-xp.mjs",
  "test-player-id.mjs",
  "test-seguranca-lancamento.mjs", // código de sala sem colisão (corrida real) + teto do log_ops_event + chat dormente fechado (10/11/2026)
  "test-pause-resume.mjs",
  "test-bot-votes.mjs",
  "test-native-auth-callback.mjs",
  "test-data-retention.mjs",
  "test-definition-filter.mjs",
  "test-near-miss.mjs",
  "test-rollback.mjs",
  "test-probe-local.mjs",
];

const results = [];
for (const s of SUITES) {
  console.log(`\n━━━━━━━━ ${s} ━━━━━━━━`);
  const r = spawnSync(process.execPath, [`scripts/${s}`], { stdio: "inherit", env: process.env });
  results.push({ s, ok: r.status === 0 });
}
console.log("\n━━━━━━━━ RESUMO ━━━━━━━━");
for (const { s, ok } of results) console.log(`${ok ? "✅" : "❌"} ${s}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} suíte(s) falharam` : `\n${results.length}/${results.length} suítes OK`);
process.exit(failed ? 1 : 0);
