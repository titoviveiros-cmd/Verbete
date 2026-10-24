import { test, expect, type Page } from "@playwright/test";

// Layout mobile (iPhone e Android) numa partida REAL (2.1.1): em cada tela —
// home, criar sala, entrar com código, lobby, escrita, votação, revelação,
// placar e a rodada seguinte — e em cada largura (320/375/390/430 px), nada
// de rolagem lateral, nenhum botão/texto fora da tela e nenhum texto de botão
// cortado. Contra o site ou o bundle nativo (https://localhost).
// Só com MOBILE_E2E=1.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.MOBILE_E2E,
  "só com E2E_BASE_URL e MOBILE_E2E=1",
);
test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  ignoreHTTPSErrors: true,
});
test.setTimeout(600_000);

const WIDTHS = [320, 375, 390, 430];
type Problem = { screen: string; width: number; what: string };
const problems: Problem[] = [];

// Uma leitura da tela: rolagem lateral, elementos fora da tela e textos de
// botão cortados.
const measure = (page: Page) =>
  page.evaluate(() => {
    const vw = window.innerWidth;
    const hidden = (el: Element) =>
      !!el.closest('[aria-hidden="true"], [inert]') ||
      Number(getComputedStyle(el).opacity) === 0;
    const off: string[] = [];
    const clipped: string[] = [];
    for (const el of document.querySelectorAll(
      "button, a, input, textarea, select, h1, h2, h3, p, li",
    )) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0 || hidden(el)) continue;
      const label = `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 28)}"`;
      if (b.left < -1 || b.right > vw + 1)
        off.push(`${label} [${Math.round(b.left)}..${Math.round(b.right)}]`);
      if (
        el.tagName === "BUTTON" &&
        el.scrollWidth > el.clientWidth + 1 &&
        getComputedStyle(el).overflowX !== "visible"
      )
        clipped.push(label);
    }
    return {
      overflow: document.documentElement.scrollWidth - vw,
      off: off.slice(0, 5),
      clipped: clipped.slice(0, 5),
    };
  });

// Opções da palavra (coordenador): nenhuma palavra cortada com reticências.
async function checkWordOptions(page: Page) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(900);
    const cut = await page.evaluate(() =>
      [...document.querySelectorAll("button.sticker p.capitalize")]
        .filter((p) => p.scrollWidth > p.clientWidth + 1)
        .map((p) => p.textContent ?? ""),
    );
    console.log(`opções da palavra @${width}: cortadas=${JSON.stringify(cut)}`);
    for (const w of cut)
      problems.push({
        screen: "escolha da palavra",
        width,
        what: `"${w}" cortada`,
      });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

async function check(page: Page, screen: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(700); // animações de entrada assentarem
    // Só vale o layout ESTÁVEL: depois de trocar a largura, barras e cartões
    // ainda se reposicionam (o lobby leu -8 px e 0 px no meio do caminho e
    // 16 px parado — conferido por print). Mede até duas leituras seguidas,
    // com 0,6 s de intervalo, darem iguais (no máximo ~6 s).
    let r = await measure(page);
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(600);
      const again = await measure(page);
      const same = JSON.stringify(again) === JSON.stringify(r);
      r = again;
      if (same) break;
    }
    console.log(`${screen} @${width}: ${JSON.stringify(r)}`);
    if (r.overflow > 0)
      problems.push({ screen, width, what: `rolagem lateral ${r.overflow}px` });
    for (const o of r.off)
      problems.push({ screen, width, what: `fora da tela: ${o}` });
    for (const c of r.clipped)
      problems.push({ screen, width, what: `texto cortado: ${c}` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

test("mobile 320/375/390/430: nenhuma tela da partida vaza ou corta", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Criar sala/ })).toBeVisible({
    timeout: 30_000,
  });
  await check(page, "home");

  await page.getByRole("button", { name: /Criar sala/ }).click();
  await expect(page.getByPlaceholder("Ex: Bia, Zé, Dudu...")).toBeVisible();
  await check(page, "criar sala");
  await page.getByRole("button", { name: /Voltar/ }).click();
  await page.getByRole("button", { name: /Entrar com código/ }).click();
  await expect(page.getByPlaceholder("0000")).toBeVisible();
  await check(page, "entrar com código");
  await page.getByRole("button", { name: /Voltar/ }).click();

  await page.getByRole("button", { name: /Criar sala/ }).click();
  await page.getByPlaceholder("Ex: Bia, Zé, Dudu...").fill("Teste Mobile");
  await expect(async () => {
    if (!/\/room\/\d{4}/.test(page.url()))
      await page
        .getByRole("button", { name: /Criar!/ })
        .click({ timeout: 3_000 });
    await expect(page).toHaveURL(/\/room\/\d{4}/, { timeout: 8_000 });
  }).toPass({ timeout: 45_000 });
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: /\+1 Bot/ }).click();
    await page.waitForTimeout(1_500);
  }
  await expect(page.getByRole("button", { name: /Começar/ })).toBeEnabled({
    timeout: 30_000,
  });
  await check(page, "lobby");
  await page.getByRole("button", { name: /Começar/ }).click();

  // escrita. Se o host for o coordenador, ele sorteia a palavra e NÃO escreve;
  // com 1 humano só, ninguém escreve e a mesa pausa (regra da pausa) —
  // "Continuar" retoma. A tela de escrita é medida na rodada em que o host
  // escreve (esta ou a seguinte: o coordenador troca a cada rodada).
  const field = page.getByPlaceholder("escreva sua definicao mirabolante...");
  const ballots = page.locator("button:has(.token)");
  const resume = page.getByRole("button", { name: /Continuar/ });
  const unpause = async () => {
    if (await resume.isVisible().catch(() => false))
      await resume.click({ timeout: 3_000 }).catch(() => {});
  };
  await expect(async () => {
    const sortear = page.getByRole("button", { name: /Sortear palavra/ });
    if (await sortear.isVisible().catch(() => false)) {
      await sortear.click({ force: true, timeout: 3_000 });
      // as 3 opções aparecem INTEIRAS (sem "Gastroenterol…") em 320–430 px
      await expect(page.getByText("Escolha uma palavra rara!")).toBeVisible({
        timeout: 15_000,
      });
      await checkWordOptions(page);
      await page
        .locator("button.sticker")
        .first()
        .click({ force: true, timeout: 15_000 });
    }
    await unpause();
    const writing = await field.isVisible().catch(() => false);
    const voting = await ballots
      .first()
      .isVisible()
      .catch(() => false);
    expect(writing || voting).toBe(true);
  }).toPass({ timeout: 180_000, intervals: [2_000] });
  let wrote = false;
  if (await field.isVisible().catch(() => false)) {
    await field.fill("utensilio usado para conferir telas pequenas");
    await check(page, "escrita");
    await page.getByRole("button", { name: /Enviar definição/ }).click();
    wrote = true;
  } else console.log("rodada 1: host é o coordenador (não escreve)");

  // votação
  await expect(async () => {
    await unpause();
    expect(await ballots.first().isVisible()).toBe(true);
  }).toPass({ timeout: 180_000, intervals: [2_000] });
  await check(page, "votação");
  const n = await ballots.count();
  for (let i = 0; i < n; i++) {
    const b = ballots.nth(i);
    if ((await b.textContent())?.includes("SUA")) continue;
    if (await b.isEnabled()) {
      await b.click({ force: true });
      break;
    }
  }

  // revelação (com os blefes já na tela) e placar
  const reveal = page.getByRole("region", { name: "Revelação da rodada" });
  await expect(async () => {
    await unpause();
    expect(await reveal.isVisible()).toBe(true);
  }).toPass({ timeout: 120_000, intervals: [2_000] });
  await expect(
    reveal.getByRole("list", { name: "Blefes da rodada" }),
  ).toBeVisible({ timeout: 30_000 });
  await check(page, "revelação");
  await expect(page.getByLabel("Placar da rodada")).toBeVisible({
    timeout: 90_000,
  });
  await check(page, "placar");

  // rodada seguinte: escolha da palavra (se for o host) ou escrita
  await expect(async () => {
    const next = page.getByRole("button", { name: /Próxima rodada/ });
    if (await next.isVisible().catch(() => false))
      await next.click({ timeout: 3_000 }).catch(() => {});
    const writing = await field.isVisible().catch(() => false);
    const choosing = await page
      .getByRole("button", { name: /Sortear palavra/ })
      .isVisible()
      .catch(() => false);
    expect(writing || choosing).toBe(true);
  }).toPass({ timeout: 120_000, intervals: [2_000] });
  await check(page, "rodada seguinte");
  // a tela de escrita precisa ter sido medida em alguma rodada
  if (!wrote) {
    await expect(field).toBeVisible({ timeout: 60_000 });
    await field.fill("utensilio usado para conferir telas pequenas");
    await check(page, "escrita");
  }

  await page
    .getByRole("button", { name: "Resetar jogo" })
    .click({ timeout: 5_000 })
    .then(() =>
      page
        .getByRole("button", { name: /Sim, resetar/ })
        .click({ timeout: 5_000 }),
    )
    .catch(() => {});
  console.log(`PROBLEMAS: ${problems.length}`);
  expect(problems, JSON.stringify(problems, null, 1)).toEqual([]);
});
