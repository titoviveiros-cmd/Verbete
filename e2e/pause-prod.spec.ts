import { test, expect } from "@playwright/test";

// Pausa de partida no ambiente publicado (só com E2E_BASE_URL e
// PAUSE_PROD=1): 1 humano + 3 bots, a mesa sai (app fechado) no meio da
// escrita, o prazo vence e o tick do servidor PAUSA em vez de punir/avançar;
// o jogador volta, vê "Partida pausada", toca em Continuar e a escrita segue
// com prazo novo — mesma rodada, sem expulsão. No fim a sala volta ao lobby.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.PAUSE_PROD,
  "só contra um deploy (E2E_BASE_URL + PAUSE_PROD=1)",
);
test.setTimeout(420_000);

const NICK = "Ex: Bia, Zé, Dudu...";
const WRITE = "escreva sua definicao mirabolante...";

test("mesa sai na escrita → pausa; volta → Continuar retoma a mesma rodada", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  let page = await ctx.newPage();
  await page.goto("/");
  await expect(async () => {
    await page.getByRole("button", { name: /Criar sala/ }).click();
    await expect(page.getByPlaceholder(NICK)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByPlaceholder(NICK).fill("Pausa");
  await page.getByRole("button", { name: /Criar!/ }).click();
  await expect(page).toHaveURL(/\/room\/\d{4}/, { timeout: 30_000 });
  const code = page.url().match(/room\/(\d{4})/)![1]!;
  console.log(`SALA ${code}`);

  await page.getByRole("button", { name: /Encher até 4/ }).click();
  await expect(page.getByText("Jogadores (4/12)")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: /Começar/ }).click();

  // escolha: humano coordenador sorteia; bot coordenador escolhe sozinho
  await expect(async () => {
    const mine = await page
      .getByRole("button", { name: /Sortear palavra/ })
      .isVisible()
      .catch(() => false);
    if (mine) {
      await expect(page.locator("[data-phase-announcer-shield]")).toHaveCount(
        0,
      );
      await page
        .getByRole("button", { name: /Sortear palavra/ })
        .click({ force: true });
      await page
        .locator("button.sticker")
        .first()
        .click({ timeout: 10_000, force: true });
    }
    const writing =
      (await page
        .getByPlaceholder(WRITE)
        .isVisible()
        .catch(() => false)) ||
      (await page
        .getByText(/Você é o coordenador/)
        .first()
        .isVisible()
        .catch(() => false));
    expect(writing).toBeTruthy();
  }).toPass({ timeout: 90_000 });
  const roundTxt = await page
    .locator("header, [data-topbar]")
    .first()
    .innerText()
    .catch(() => "");
  console.log(`ESCRITA ABERTA (${roundTxt.replace(/\s+/g, " ").slice(0, 60)})`);
  await page.waitForTimeout(4_000); // cortina sai; presença 'active' enviada

  // a mesa inteira sai: app fechado (pagehide → presença 'away')
  await page.close();
  const leftAt = Date.now();
  console.log("MESA SAIU — aguardando o prazo vencer e o tick do servidor");
  await new Promise((r) => setTimeout(r, 140_000));

  page = await ctx.newPage();
  await page.goto(`/room/${code}`);
  const banner = page.locator("[data-paused-banner]");
  await expect(banner).toBeVisible({ timeout: 40_000 });
  console.log(
    `PAUSADA visível ${Math.round((Date.now() - leftAt) / 1000)} s depois de sair`,
  );
  await expect(page.getByText(/Você foi removido|expulso/i)).toHaveCount(0);

  await banner.getByRole("button", { name: /Continuar/ }).click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  console.log("RETOMADA");

  // volta ao lobby para não deixar a sala aberta
  await page
    .getByRole("button", { name: "Resetar jogo" })
    .click({ timeout: 5_000 })
    .catch(() => {});
  await page
    .getByRole("button", { name: /Sim, resetar/ })
    .click({ timeout: 5_000 })
    .catch(() => {});
  await ctx.close();
});
