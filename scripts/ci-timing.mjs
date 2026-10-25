// Tempos REAIS de runs da CI (GitHub Actions) — só o que a API registrou,
// nada estimado. Uso: node scripts/ci-timing.mjs <run-id> [<run-id>…]
// (precisa do `gh` autenticado). Para cada run: total do início da tentativa
// (run_started_at — numa re-execução, created_at é o da 1ª) ao fim do último
// job, fila do push ao início (só 1ª tentativa), cada job e passo ≥ 1 s, e as
// suítes do run-integration pelos carimbos das linhas "━━━━━━━━ x ━━━━━━━━"
// do log do job integration.
import { execFileSync } from "node:child_process";

const REPO = process.env.CI_TIMING_REPO ?? "titoviveiros-cmd/Verbete";
const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!ids.length) {
  console.error("uso: node scripts/ci-timing.mjs <run-id> [<run-id>…]");
  process.exit(2);
}

const api = (path, ...flags) =>
  execFileSync("gh", ["api", ...flags, path], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
const secs = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;
const fmt = (s) => {
  if (s == null || Number.isNaN(s)) return "—";
  const t = Math.round(s);
  return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, "0")}s`;
};
const row = (label, s, extra = "") => console.log(`  ${label.padEnd(44)} ${fmt(s).padStart(7)}${extra}`);

// Suítes do run-integration: do marcador de cada uma ao marcador seguinte.
function suiteTimes(jobId) {
  let log;
  try {
    log = api(`repos/${REPO}/actions/jobs/${jobId}/logs`, "--allow-escape-sequences");
  } catch {
    return [];
  }
  const marks = [];
  for (const line of log.split("\n")) {
    const m = line.match(/^(\S+Z) .*━━━━━━━━ (\S+) ━━━━━━━━/);
    if (m) marks.push({ at: m[1], name: m[2] });
  }
  return marks.slice(0, -1).map((m, i) => ({ name: m.name, s: secs(m.at, marks[i + 1].at) }));
}

for (const id of ids) {
  const run = JSON.parse(api(`repos/${REPO}/actions/runs/${id}`));
  const { jobs } = JSON.parse(api(`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`));
  const done = jobs.filter((j) => j.completed_at);
  const lastEnd = done.length === jobs.length ? done.map((j) => j.completed_at).sort().at(-1) : null;
  console.log(
    `\nCI TIMING — run ${id} (${run.name}, ${run.event}, ${run.head_sha.slice(0, 7)}, tentativa ${run.run_attempt}, ${run.conclusion ?? run.status})`,
  );
  row("total: início do run → último job concluído", lastEnd ? secs(run.run_started_at, lastEnd) : null);
  if (run.run_attempt === 1) row("fila: push → início do run", secs(run.created_at, run.run_started_at));
  for (const j of jobs) {
    const s = j.completed_at ? secs(j.started_at, j.completed_at) : null;
    const start = secs(run.run_started_at, j.started_at);
    row(`job ${j.name}`, s, `   (começa em +${fmt(start)}, ${j.conclusion ?? j.status})`);
    for (const st of j.steps ?? []) {
      if (!st.started_at || !st.completed_at) continue;
      const d = secs(st.started_at, st.completed_at);
      if (d >= 1) row(`  · ${st.name.slice(0, 40)}`, d);
    }
    if (j.name === "integration") {
      for (const t of suiteTimes(j.id)) row(`      ${t.name}`, t.s);
    }
  }
}
