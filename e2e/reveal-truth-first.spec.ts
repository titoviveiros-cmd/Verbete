import { test, expect, type Page } from "@playwright/test";

// Revelação "verdade primeiro" com REDE LENTA (2.1.1). Na votação o servidor
// manda as cédulas sem autor e sem a marca da verdadeira; o shape da
// revelação chega depois (get_round_sync). Aqui cada leitura atrasa 5 s a
// partir do voto, como num celular em rede ruim, e a tela é registrada a
// cada 100 ms: a verdade tem de aparecer COM o texto antes de qualquer
// blefe, e a verdadeira nunca pode entrar na lista de blefes.
// Contra o site ou o bundle nativo (https://localhost). Só com REVEAL_E2E=1.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.REVEAL_E2E,
  "só com E2E_BASE_URL e REVEAL_E2E=1",
);
test.use({ ignoreHTTPSErrors: true });
test.setTimeout(480_000);

async function untilVoting(page: Page) {
  await page.goto("/");
  await expect(async () => {
    await page.getByRole("button", { name: /Criar sala/ }).click();
    await expect(page.getByPlaceholder("Ex: Bia, Zé, Dudu...")).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await page.getByPlaceholder("Ex: Bia, Zé, Dudu...").fill("Teste Ordem");
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
  await page.getByRole("button", { name: /Começar/ }).click();
  const ballots = page.locator("button:has(.token)");
  await expect(async () => {
    const sortear = page.getByRole("button", { name: /Sortear palavra/ });
    if (await sortear.isVisible().catch(() => false)) {
      await sortear.click({ force: true, timeout: 3_000 });
      await page
        .locator("button.sticker")
        .first()
        .click({ force: true, timeout: 15_000 });
    }
    const field = page.getByPlaceholder("escreva sua definicao mirabolante...");
    if (await field.isVisible().catch(() => false)) {
      await field.fill("objeto curioso usado em testes de ordem");
      await page
        .getByRole("button", { name: /Enviar definição/ })
        .click({ timeout: 3_000 })
        .catch(() => {});
    }
    expect(await ballots.first().isVisible()).toBe(true);
  }).toPass({ timeout: 240_000, intervals: [2_000] });
  return ballots;
}

type Snap = { t: number; truth: string | null; bluffs: string[] };

test("rede lenta: a verdade aparece com o texto antes de qualquer blefe", async ({
  page,
}) => {
  let slow = false;
  // as duas leituras que trazem definições (poll da fase e recarga da sala)
  for (const rpc of ["get_round_sync", "get_room_state"])
    await page.route(`**/rest/v1/rpc/${rpc}`, async (route) => {
      if (slow) await new Promise((r) => setTimeout(r, 5_000));
      await route.continue().catch(() => {});
    });
  const ballots = await untilVoting(page);
  slow = true; // daqui em diante toda leitura da rodada chega 5 s depois
  const n = await ballots.count();
  for (let i = 0; i < n; i++) {
    const b = ballots.nth(i);
    if ((await b.textContent())?.includes("SUA")) continue;
    if (await b.isEnabled()) {
      await b.click({ force: true });
      break;
    }
  }
  await expect(
    page.getByRole("region", { name: "Revelação da rodada" }),
  ).toBeVisible({ timeout: 120_000 });

  const snaps: Snap[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000) {
    const s = await page
      .evaluate(() => {
        const region = document.querySelector(
          '[aria-label="Revelação da rodada"]',
        );
        if (!region) return null;
        const sec = region.querySelector(
          'section[aria-label="Resposta correta"]',
        );
        const quoted = sec?.textContent?.match(/“([^”]*)”/)?.[1] ?? null;
        const list = region.querySelector('ol[aria-label="Blefes da rodada"]');
        const bluffs = list
          ? [...list.children].map((li) => li.textContent ?? "")
          : [];
        return { truth: quoted, bluffs };
      })
      .catch(() => null);
    if (!s) break; // saiu da revelação (placar)
    snaps.push({ t: Date.now() - t0, ...s });
    await page.waitForTimeout(100);
  }
  const finalTruth = [...snaps].reverse().find((s) => s.truth)?.truth ?? "";
  const firstTruth = snaps.find((s) => s.truth !== null);
  const firstBluff = snaps.find((s) => s.bluffs.length > 0);
  console.log(
    `REVELAÇÃO (rede lenta): 1ª verdade em ${firstTruth?.t ?? "-"} ms com "${(firstTruth?.truth ?? "").slice(0, 40)}" | 1º blefe em ${firstBluff?.t ?? "-"} ms | verdade final "${finalTruth.slice(0, 40)}" | ${snaps.length} quadros`,
  );
  // instrumento: a tela de fato esperou (sem verdade e sem blefes) — se ela
  // montasse já com tudo, o teste passaria até no código antigo
  expect(
    snaps.some((s) => s.truth === null && s.bluffs.length === 0),
    "houve espera observada",
  ).toBe(true);
  expect(finalTruth, "a verdade foi mostrada").not.toBe("");
  expect(firstTruth?.truth, "1ª verdade já com o texto certo").toBe(finalTruth);
  expect(firstBluff, "houve blefes").toBeTruthy();
  expect(firstTruth!.t, "verdade antes do 1º blefe").toBeLessThan(
    firstBluff!.t,
  );
  const leaked = snaps.filter((s) =>
    s.bluffs.some((b) => b.includes(finalTruth)),
  );
  expect(leaked.length, "a verdadeira nunca na lista de blefes").toBe(0);
});
