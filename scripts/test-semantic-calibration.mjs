// Calibração AO VIVO do juiz semântico: cada par da bateria passa pelos DOIS
// modos com o Gemini de verdade e pelo MESMO código de produção
// (scoreGuess = Diário, judgeCandidates = multiplayer). Fora do CI: precisa
// de GEMINI_API_KEY (env ou .env local). Nada de banco, nada de produção.
// Uso: node scripts/test-semantic-calibration.mjs
import { readFileSync, existsSync } from "node:fs";
import {
  SEMANTIC_THRESHOLD,
  judgeCandidates,
  scoreGuess,
} from "../supabase/functions/_shared/semantic.ts";
import { BATCH, CASES } from "./semantic-calibration-cases.mjs";

const apiKey =
  process.env.GEMINI_API_KEY ??
  (existsSync(".env")
    ? readFileSync(".env", "utf8").match(/^GEMINI_API_KEY="?([^"\r\n]+)"?/m)?.[1]
    : undefined);
if (!apiKey) {
  console.log("pulado: sem GEMINI_API_KEY");
  process.exit(0);
}

const PACE_MS = Number(process.env.CALIBRATION_PACE_MS ?? 4200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
// ritmo abaixo do limite por minuto da cota; 429/5xx persistente = espera e repete
async function paced(fn) {
  let r;
  for (let i = 0; i < 4; i++) {
    const wait = lastCall + PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    r = await fn();
    const transient = !r.ok && (r.status === 429 || (r.status ?? 0) >= 500 || r.reason === "timeout" || r.reason === "network");
    if (!transient) return r;
    await sleep(20_000);
  }
  return r;
}

const LIMITS = { alto: (s) => s >= SEMANTIC_THRESHOLD, baixo: (s) => s < SEMANTIC_THRESHOLD, muito_baixo: (s) => s < 40 };
const results = [];
for (const c of CASES) {
  const daily = await paced(() => scoreGuess({ fetchFn: fetch, apiKey, word: c.word, truth: c.truth, guess: c.guess }));
  const judge = await paced(() =>
    judgeCandidates({ fetchFn: fetch, apiKey, word: c.word, truth: c.truth, candidates: [{ id: "c1", text: c.guess }] }),
  );
  const d = daily.ok ? daily.score : null;
  const j = judge.ok ? (judge.scores.get("c1") ?? null) : null;
  const matched = judge.ok && judge.matches.includes("c1");
  const pass =
    d !== null &&
    j !== null &&
    LIMITS[c.expect](d) &&
    LIMITS[c.expect](j) &&
    matched === (c.expect === "alto");
  results.push({ ...c, d, j, matched, pass, agree: d !== null && j !== null && (d >= SEMANTIC_THRESHOLD) === matched });
  console.log(
    `${pass ? "✅" : "❌"} [${c.cat}] ${c.word}: "${c.guess}" → Diário ${d ?? (daily.reason ?? "?")} · multiplayer ${j ?? (judge.reason ?? "?")}${matched ? " (aprova)" : ""} · esperado ${c.expect}`,
  );
}

console.log("\n— Rodada de multiplayer com várias candidatas (mesma verdade)");
const batch = await paced(() =>
  judgeCandidates({ fetchFn: fetch, apiKey, word: BATCH.word, truth: BATCH.truth, candidates: BATCH.candidates }),
);
let batchFails = 0;
for (const c of BATCH.candidates) {
  const s = batch.ok ? (batch.scores.get(c.id) ?? null) : null;
  const ok = s !== null && LIMITS[c.expect](s) && (batch.ok && batch.matches.includes(c.id)) === (c.expect === "alto");
  if (!ok) batchFails++;
  console.log(`${ok ? "✅" : "❌"} "${c.text}" → ${s ?? (batch.reason ?? "?")} · esperado ${c.expect}`);
}

const fails = results.filter((r) => !r.pass);
const disagree = results.filter((r) => !r.agree);
console.log(
  `\n${results.length - fails.length}/${results.length} pares OK · lote ${BATCH.candidates.length - batchFails}/${BATCH.candidates.length} · Diário e multiplayer com a MESMA decisão em ${results.length - disagree.length}/${results.length}`,
);
for (const f of fails) console.log(`   FALHA [${f.cat}] ${f.word}: Diário ${f.d} · multiplayer ${f.j} · esperado ${f.expect}`);
process.exit(fails.length || batchFails ? 1 : 0);
