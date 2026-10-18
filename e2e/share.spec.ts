import { test, expect } from "@playwright/test";

// O botão Compartilhar do lobby usa SEMPRE a URL pública canônica — mesmo
// com o app servido de localhost (no Android o WebView roda em
// https://localhost e o código antigo mostrava um aviso do Lovable sem
// compartilhar nada: VIR-02/MOB-02).
test("Compartilhar copia o convite com a URL pública da sala", async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL,
  });
  const page = await ctx.newPage();
  // Força o caminho da área de transferência (a Web Share API varia por SO).
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      value: undefined,
      configurable: true,
    });
  });

  await page.goto("/");
  const nick = page.getByPlaceholder("Ex: Bia, Zé, Dudu...");
  await expect(async () => {
    await page.getByRole("button", { name: /Criar sala/ }).click();
    await expect(nick).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await nick.fill("E2E Share");
  await page.getByRole("button", { name: /Criar!/ }).click();
  await expect(page).toHaveURL(/\/room\/\d{4}/, { timeout: 20_000 });
  const code = page.url().match(/room\/(\d{4})/)![1];

  await page.getByRole("button", { name: /Compartilhar/ }).click();
  await expect(page.getByRole("button", { name: /Copiado/ })).toBeVisible({
    timeout: 5_000,
  });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`https://jogo.verbete.workers.dev/?join=${code}`);
  await expect(page.getByText(/Publish/)).toHaveCount(0);

  await ctx.close();
});
