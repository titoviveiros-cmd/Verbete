import { appendFileSync } from "node:fs";
import { relative, sep } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
} from "@playwright/test/reporter";

// Tempo por spec e por teste — o reporter "github" do CI só mostra o total.
// Só mede: não muda execução, ordem, timeouts nem retries. No fim imprime a
// tabela PLAYWRIGHT TIMING e, no GitHub Actions, anexa ao resumo do job.
// Ordem do runner (1.61): reporter criado → webServer + globalSetup + carga
// dos specs → onBegin → testes → onEnd.

type Row = {
  tests: number;
  passed: number;
  skipped: number;
  failed: number;
  flaky: number;
  retries: number;
  ms: number;
};

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

export default class TimingReporter implements Reporter {
  private t0 = Date.now();
  private tBegin = 0;
  private tFirst = 0;
  private suite?: Suite;

  onBegin(_config: FullConfig, suite: Suite) {
    this.tBegin = Date.now();
    this.suite = suite;
  }

  onTestBegin() {
    if (!this.tFirst) this.tFirst = Date.now();
  }

  onEnd(result: FullResult) {
    const tests: TestCase[] = this.suite?.allTests() ?? [];
    const rows = new Map<string, Row>();
    const total: Row = {
      tests: 0,
      passed: 0,
      skipped: 0,
      failed: 0,
      flaky: 0,
      retries: 0,
      ms: 0,
    };
    const perTest: { ms: number; name: string }[] = [];
    for (const t of tests) {
      const file = relative(process.cwd(), t.location.file)
        .split(sep)
        .join("/");
      const row = rows.get(file) ?? {
        tests: 0,
        passed: 0,
        skipped: 0,
        failed: 0,
        flaky: 0,
        retries: 0,
        ms: 0,
      };
      const ms = t.results.reduce((s, r) => s + r.duration, 0);
      const outcome = t.outcome();
      for (const r of [row, total]) {
        r.tests++;
        r.ms += ms;
        r.retries += t.results.filter((x) => x.retry > 0).length;
        if (outcome === "expected") r.passed++;
        else if (outcome === "skipped") r.skipped++;
        else if (outcome === "flaky") r.flaky++;
        else r.failed++;
      }
      rows.set(file, row);
      perTest.push({ ms, name: `${file}:${t.location.line} › ${t.title}` });
    }
    const line = (name: string, r: Row) =>
      `${name.padEnd(52)} ${[
        r.tests,
        r.passed,
        r.skipped,
        r.failed,
        r.flaky,
        r.retries,
      ]
        .map((n) => String(n).padStart(6))
        .join("")} ${fmt(r.ms).padStart(7)}`;
    const end = Date.now();
    const out = [
      `PLAYWRIGHT TIMING — status=${result.status} · ${tests.length} testes descobertos`,
      `${"arquivo".padEnd(52)} ${["testes", "pass", "skip", "fail", "flaky", "retry"].map((h) => h.padStart(6)).join("")} ${"tempo".padStart(7)}`,
      ...[...rows]
        .sort((a, b) => b[1].ms - a[1].ms)
        .map(([f, r]) => line(f, r)),
      line("TOTAL (soma dos testes, todas as tentativas)", total),
      `início → onBegin (webServer + globalSetup + carga):  ${fmt(this.tBegin - this.t0)}`,
      `onBegin → 1º teste (worker + navegador):             ${fmt((this.tFirst || end) - this.tBegin)}`,
      `total do runner até onEnd:                           ${fmt(end - this.t0)}`,
      "TOP 10 TESTES (tempo somando tentativas)",
      ...perTest
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 10)
        .map(
          (t, i) =>
            `${String(i + 1).padStart(3)}. ${fmt(t.ms).padStart(6)}  ${t.name}`,
        ),
    ].join("\n");
    console.log(`\n${out}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n\`\`\`text\n${out}\n\`\`\`\n`,
      );
    }
  }
}
