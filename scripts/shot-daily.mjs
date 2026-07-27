// Screenshot da tela de resultado do Desafio Diário (usuário de teste logado).
import { chromium } from "@playwright/test";
const BASE = "https://jogo.verbete.workers.dev";
const browser = await chromium.launch({
  args: process.env.E2E_RESOLVE
    ? [`--host-resolver-rules=${process.env.E2E_RESOLVE}`]
    : [],
});
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
await page.goto(`${BASE}/login`);
await page.waitForTimeout(2500);
await page.locator('input[type="email"]').fill("e2e-daily@verbete.test");
await page.locator('input[type="password"]').fill("senha-e2e-123");
await page.getByRole("button", { name: /^Entrar$/ }).click();
await page.waitForTimeout(3000);
await page.goto(`${BASE}/daily`);
await page.waitForTimeout(4000);
const ta = page.locator("textarea");
if (await ta.isVisible().catch(() => false)) {
  await ta.fill("caravana de camelos no deserto");
  await page.getByRole("button", { name: /Enviar palpite/ }).click();
  await page.waitForTimeout(9000);
}
await page.screenshot({ path: "shots-daily.png", fullPage: false });
await browser.close();
console.log("ok: shots-daily.png");
