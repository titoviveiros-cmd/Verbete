// Auditoria WCAG 2.1 AA (axe-core) nas telas públicas do deploy.
// Uso: node scripts/audit-a11y.mjs [base-url]
// DNS de *.workers.dev quebrado nesta máquina → usa host-resolver-rules.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const BASE = process.argv[2] ?? "https://jogo.verbete.workers.dev";
const RESOLVE = process.env.E2E_RESOLVE ?? "MAP jogo.verbete.workers.dev 104.21.2.131";
const PAGES = ["/", "/login", "/daily", "/ranking", "/download"];

const browser = await chromium.launch({
  args: [`--host-resolver-rules=${RESOLVE}`],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
let totalViolations = 0;

for (const path of PAGES) {
  const pg = await ctx.newPage();
  await pg.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
  await pg.waitForTimeout(1500); // hidratação + animações de entrada
  await pg.addScriptTag({ content: axeSource });
  const result = await pg.evaluate(async () => {
    // eslint-disable-next-line no-undef
    return await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
  });
  // Falso positivo conhecido: o wordmark "Verbete" usa -webkit-text-stroke
  // roxo (#4c1a8f) com paint-order stroke-fill — o axe lê o CONTORNO como cor
  // do texto, mas o preenchimento é branco sobre fundo escuro (≈14:1 real).
  const v = result.violations.filter(
    (viol) =>
      !(
        viol.id === "color-contrast" &&
        viol.nodes.every(
          (n) => n.any[0]?.data?.fgColor?.toLowerCase() === "#4c1a8f",
        )
      ),
  );
  console.log(`\n=== ${path} — ${v.length} violações ===`);
  for (const viol of v) {
    totalViolations++;
    console.log(`  [${viol.impact}] ${viol.id}: ${viol.help}`);
    for (const node of viol.nodes.slice(0, 3)) {
      console.log(`    → ${node.target.join(" ")}`);
    }
  }
  await pg.close();
}

await browser.close();
console.log(
  totalViolations === 0
    ? "\nA11Y OK — nenhuma violação WCAG 2.1 AA nas telas públicas"
    : `\n${totalViolations} violações no total`,
);
process.exit(totalViolations === 0 ? 0 : 1);
