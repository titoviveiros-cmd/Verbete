// Roda TODAS as suítes de integração (Supabase local do CI) e só falha no
// fim, com o resumo — uma falha não esconde as demais.
// test-judge-calibration fica de fora: depende da chave real do Gemini
// (test-edges-e2e cobre o mesmo caminho com um Gemini simulado).
// ci-android.mjs (Gradle) só roda no CI com Android SDK; é no-op local.
import { spawnSync } from "node:child_process";

const SUITES = [
  "ci-deno-check.mjs",
  "test-identity.mjs",
  "test-e2e-round.mjs",
  "test-security-rest.mjs",
  "test-shuffling-deadlock.mjs",
  "test-similarity-bonus.mjs",
  "test-edges-e2e.mjs",
  "test-phase-secs.mjs",
  "test-ops.mjs",
  "test-ops-health.mjs",
  "test-rollback.mjs",
  "ci-android.mjs",
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
