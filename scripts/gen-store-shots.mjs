// Screenshots REAIS de gameplay para a ficha da Play Store (1080×2340 ÷ 3).
// Joga uma rodada completa contra a PRODUÇÃO (mesmo roteiro do E2E
// full-round) com dois navegadores e captura os momentos-chave.
// Saída: resources/store/shot-*.png (390×844 @3x = 1170×2532)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.cwd(), "resources", "store");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.SHOT_BASE ?? "https://jogo.verbete.workers.dev";
const RESOLVE =
  process.env.E2E_RESOLVE ?? "MAP jogo.verbete.workers.dev 104.21.2.131";
const NICK = "Ex: Bia, Zé, Dudu...";

const browser = await chromium.launch({
  args: [`--host-resolver-rules=${RESOLVE}`],
});
const mk = async () =>
  (
    await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
    })
  ).newPage();
const host = await mk();
const guest = await mk();
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(OUT, `${name}.png`) });
  console.log(`✔ ${name}.png`);
};
const clickUntil = async (page, re, probe) => {
  for (let i = 0; i < 15; i++) {
    await page
      .getByRole("button", { name: re })
      .click()
      .catch(() => {});
    if (await probe().catch(() => false)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error(`clickUntil falhou: ${re}`);
};

// Home
await host.goto(BASE + "/", { waitUntil: "networkidle" });
await host.waitForTimeout(2500);
await shot(host, "shot-1-home");

// Criar sala
await clickUntil(host, /Criar sala/, () =>
  host.getByPlaceholder(NICK).isVisible(),
);
await host.getByPlaceholder(NICK).fill("Tito");
await host.getByRole("button", { name: /Criar!/ }).click();
await host.waitForURL(/\/room\/\d{4}/, { timeout: 20000 });
const code = host.url().match(/room\/(\d{4})/)[1];
console.log("sala", code);

// Convidada entra
await guest.goto(`${BASE}/room/${code}`);
await guest.getByPlaceholder(NICK).waitFor({ timeout: 20000 });
await guest.getByPlaceholder(NICK).fill("Bia");
await guest.getByRole("button", { name: /Entrar na sala/ }).click();
await host.getByText("Bia").first().waitFor({ timeout: 25000 });
await host.waitForTimeout(1200);
await shot(host, "shot-2-lobby");

// Começar
await host.getByRole("button", { name: /Começar/ }).click();
const pages = [host, guest];
let coord;
for (let i = 0; i < 40 && !coord; i++) {
  for (const p of pages) {
    if (
      await p
        .getByRole("button", { name: /Sortear palavra/ })
        .isVisible()
        .catch(() => false)
    )
      coord = p;
  }
  if (!coord) await new Promise((r) => setTimeout(r, 1000));
}
if (!coord) throw new Error("coordenador não encontrado");
const writer = pages.find((p) => p !== coord);

await coord.getByRole("button", { name: /Sortear palavra/ }).click();
await coord.locator("button.sticker").first().waitFor({ timeout: 20000 });
await coord.waitForTimeout(800);
await shot(coord, "shot-3-escolha");
await coord.locator("button.sticker").first().click();

// Escrita
const ta = writer.getByPlaceholder("escreva sua definicao mirabolante...");
await ta.waitFor({ timeout: 30000 });
await writer.waitForTimeout(800);
await shot(writer, "shot-4-escrita");
for (let i = 0; i < 15; i++) {
  await ta
    .fill("aquele friozinho na barriga antes de mentir bonito", {
      timeout: 3000,
    })
    .catch(() => {});
  await writer
    .getByRole("button", { name: /Enviar definição/ })
    .click({ timeout: 3000 })
    .catch(() => {});
  const ok = await writer
    .getByText(/Definição enviada|Embaralhando as cédulas|A palavra é/)
    .first()
    .isVisible()
    .catch(() => false);
  if (ok) break;
  await writer.waitForTimeout(1000);
}

// Votação
const cedula = (p) => p.locator("button:has(span.text-sun):not([disabled])");
await cedula(host).first().waitFor({ timeout: 60000 });
await host.waitForTimeout(1000);
await shot(host, "shot-5-votacao");
for (const p of pages) {
  await cedula(p).first().waitFor({ timeout: 60000 });
  await cedula(p).first().click();
}

// Revelação: espera a verdade aparecer (chip 🎯) e captura o clímax
await host
  .getByText(/significado verdadeiro|Placar em/i)
  .first()
  .waitFor({ timeout: 90000 })
  .catch(() => {});
await host.waitForTimeout(2500);
await shot(host, "shot-6-revelacao");

// Placar
await host
  .getByText(/Como cada um pontuou|Pontuação por equipe/)
  .first()
  .waitFor({ timeout: 120000 });
await host.waitForTimeout(1500);
await shot(host, "shot-7-placar");

await browser.close();
console.log("\nScreenshots da loja prontos em resources/store/");
