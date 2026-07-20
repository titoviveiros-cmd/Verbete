// Capturas de verificação visual da Fase 3 (headless — fora do painel ocluso).
// Uso: node scripts/shots.mjs (dev server precisa estar em localhost:5173)
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

await page.goto("http://localhost:5173/");
await page.waitForTimeout(2500); // hidratação + animações de entrada
await page.screenshot({ path: "shots-home.png" });

// Formulário de criar sala (marca canônica no lugar do gradiente)
for (let i = 0; i < 10; i++) {
  await page.getByRole("button", { name: /Criar sala/ }).click();
  const visible = await page
    .getByPlaceholder("Ex: Bia, Zé, Dudu...")
    .isVisible()
    .catch(() => false);
  if (visible) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(800);
await page.screenshot({ path: "shots-form.png" });

// Página de download
await page.goto("http://localhost:5173/download");
await page.waitForTimeout(1500);
await page.screenshot({ path: "shots-download.png" });

await browser.close();
console.log("capturas: shots-home.png, shots-form.png, shots-download.png");
