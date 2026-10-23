import { test, expect, type Page, type Route } from "@playwright/test";

// Placar sem o detalhamento num aparelho (playtest 2026-10-22) — só com
// SCORE_E2E=1 contra um deploy (E2E_BASE_URL). Dois humanos + 2 bots, UMA
// rodada (a IA divide a cota com a produção). O CONVIDADO tem a 1ª leitura
// de get_room_definitions PRESA (SCORE_FAULT=hang, padrão: o pedido fica
// pendente, como numa rede que travou) ou com erro 503 (SCORE_FAULT=fail);
// o host lê normal. No placar os dois têm de mostrar o MESMO detalhamento.
// Também confere que "Nova sala" e "Entrar na sala" não têm mais as
// bolinhas de cor. No fim reseta a sala.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.SCORE_E2E,
  "só contra um deploy (E2E_BASE_URL) com SCORE_E2E=1",
);
test.setTimeout(600_000);

const NICK = "Ex: Bia, Zé, Dudu...";
const WRITE = "escreva sua definicao mirabolante...";
const FAULT = process.env.SCORE_FAULT ?? "hang";

/** Linhas do "como cada um pontuou", por jogador, como a tela mostra. */
const breakdown = (p: Page) =>
  p.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const el of Array.from(document.querySelectorAll(".sticker"))) {
      const name = el.querySelector(".font-display.text-xl")?.textContent;
      if (!name) continue;
      out[name] = Array.from(el.querySelectorAll("li.chip")).map(
        (li) => li.textContent ?? "",
      );
    }
    return out;
  });

test("placar: os 2 aparelhos mostram o mesmo detalhamento mesmo com a 1ª leitura presa num deles", async ({
  browser,
}) => {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  const held: Route[] = [];
  let code = "";
  try {
    // ---------------------------------------------------- Nova sala (host)
    await host.goto("/");
    await expect(async () => {
      await host.getByRole("button", { name: /Criar sala/ }).click();
      await expect(host.getByPlaceholder(NICK)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const dotsHost = await host.getByLabel(/Escolher cor/).count();
    expect.soft(dotsHost).toBe(0);
    expect
      .soft(await host.getByLabel(/Escolher avatar/).count())
      .toBeGreaterThan(8);
    await host.getByPlaceholder(NICK).fill("Host P");
    await expect(async () => {
      if (!/\/room\/\d{4}/.test(host.url()))
        await host
          .getByRole("button", { name: /Criar!/ })
          .click({ timeout: 3_000 });
      await expect(host).toHaveURL(/\/room\/\d{4}/, { timeout: 8_000 });
    }).toPass({ timeout: 45_000 });
    code = host.url().match(/room\/(\d{4})/)![1]!;
    console.log(`SALA ${code}`);
    // ------------------------------------------- Entrar na sala (convidado)
    await host.waitForTimeout(1_500);
    await guest.goto(`/room/${code}`);
    await expect(guest.getByPlaceholder(NICK)).toBeVisible({ timeout: 30_000 });
    expect.soft(await guest.getByLabel(/Escolher cor/).count()).toBe(0);
    expect
      .soft(await guest.getByLabel(/Escolher avatar/).count())
      .toBeGreaterThan(8);
    await guest.getByPlaceholder(NICK).fill("Conv P");
    await guest.getByRole("button", { name: /Entrar na sala/ }).click();
    await expect(host.getByText("Conv P").first()).toBeVisible({
      timeout: 30_000,
    });
    console.log(
      `BOLINHAS DE COR: nova sala=${dotsHost}, entrar na sala=${await guest
        .getByLabel(/Escolher cor/)
        .count()}`,
    );
    const seated = async () =>
      Number(
        ((await host.locator("body").innerText()).match(
          /Jogadores \((\d+)\/12\)/i,
        ) ?? [])[1] ?? 0,
      );
    for (let i = 0; i < 2; i++) {
      const before = await seated();
      await host.getByRole("button", { name: /\+1 Bot/ }).click();
      await expect.poll(seated, { timeout: 30_000 }).toBeGreaterThan(before);
    }
    // a 1ª leitura do histórico do placar no CONVIDADO fica presa / falha
    let faults = 1;
    await guest.route("**/rest/v1/rpc/get_room_definitions**", async (r) => {
      if (faults > 0) {
        faults--;
        console.log(`FALHA INJETADA NO CONVIDADO: ${FAULT}`);
        if (FAULT === "fail")
          return r.fulfill({ status: 503, body: '{"message":"teste"}' });
        held.push(r); // nunca responde: só o prazo do aparelho a encerra
        return;
      }
      return r.continue();
    });
    await host.getByRole("button", { name: /Começar/ }).click();
    const humans = [host, guest];
    // ---------------------------------------------------------- escolha
    await expect(async () => {
      for (const p of humans) {
        const sortear = p.getByRole("button", { name: /Sortear palavra/ });
        if (await sortear.isVisible().catch(() => false)) {
          await sortear.click({ force: true, timeout: 3_000 });
          await p
            .locator("button.sticker")
            .first()
            .click({ force: true, timeout: 15_000 });
        }
      }
      const inWriting = await Promise.all(
        humans.map(
          async (p) =>
            (await p
              .getByPlaceholder(WRITE)
              .isVisible()
              .catch(() => false)) ||
            (await p
              .getByText(/Você é o coordenador/i)
              .first()
              .isVisible()
              .catch(() => false)),
        ),
      );
      expect(inWriting.some(Boolean)).toBeTruthy();
    }).toPass({ timeout: 120_000, intervals: [1_000] });
    // ---------------------------------------------------------- escrita
    for (const [i, p] of humans.entries()) {
      const field = p.getByPlaceholder(WRITE);
      const coord = p.getByText(/Você é o coordenador/i).first();
      const past = p
        .getByText(/embaralhando as cédulas|Qual é o significado de/i)
        .first();
      await expect
        .poll(
          async () =>
            (await field.isVisible().catch(() => false)) ||
            (await coord.isVisible().catch(() => false)) ||
            (await past.isVisible().catch(() => false)),
          { timeout: 90_000, intervals: [250] },
        )
        .toBe(true);
      if (!(await field.isVisible().catch(() => false))) continue;
      await p.waitForTimeout(4_000); // a cortina sai
      await expect(async () => {
        await field.fill(
          i === 0
            ? "utensilio antigo de cozinha para ralar milho"
            : "danca de roda tipica das festas do interior",
        );
        await p
          .getByRole("button", { name: /Enviar definição/ })
          .click({ timeout: 3_000 });
        await expect(field).toBeHidden({ timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
    }
    // ---------------------------------------------------------- votação
    const ballots = (p: Page) =>
      p.locator("button:has(.token):not([disabled])");
    for (const p of humans) {
      await expect(ballots(p).first()).toBeVisible({ timeout: 120_000 });
      await ballots(p).first().click({ force: true });
      await p.waitForTimeout(800);
    }
    // ---------------------------------------------------------- placar
    for (const p of humans)
      await expect(p.getByText(/Como cada um pontuou/i).first()).toBeVisible({
        timeout: 120_000,
      });
    const t0 = Date.now();
    console.log(`PLACAR NA TELA (falhas pendentes: ${faults})`);
    let a: Record<string, string[]> = {};
    let b: Record<string, string[]> = {};
    let sawLoading = false;
    let convergedAt: number | null = null;
    const full = (x: Record<string, string[]>) =>
      Object.keys(x).length >= 4 && Object.values(x).every((l) => l.length > 0);
    while (Date.now() - t0 < 15_000) {
      a = await breakdown(host);
      b = await breakdown(guest);
      if (
        await guest
          .locator('[data-score-details="loading"]')
          .isVisible()
          .catch(() => false)
      )
        sawLoading = true;
      if (full(a) && JSON.stringify(a) === JSON.stringify(b)) {
        convergedAt = Date.now() - t0;
        break;
      }
      await host.waitForTimeout(250);
    }
    console.log(`PLACAR HOST: ${JSON.stringify(a)}`);
    console.log(`PLACAR CONVIDADO: ${JSON.stringify(b)}`);
    console.log(
      `CONVIDADO viu "carregando os detalhes": ${sawLoading ? "SIM" : "NÃO"}`,
    );
    console.log(
      convergedAt === null
        ? "=== NÃO CONVERGIU em 15 s"
        : `=== CONVERGIU ${convergedAt} ms depois do placar na tela`,
    );
    expect(full(a)).toBeTruthy();
    expect(b).toEqual(a);
  } finally {
    for (const r of held) await r.abort().catch(() => {});
    if (code) {
      try {
        await host
          .getByRole("button", { name: "Resetar jogo" })
          .click({ timeout: 15_000 });
        await host
          .getByRole("button", { name: /Sim, resetar/ })
          .click({ timeout: 10_000 });
        await expect(
          host.getByRole("button", { name: /Começar|Mín\. 4/ }),
        ).toBeVisible({ timeout: 30_000 });
        console.log(`SALA ${code} RESETADA PARA O LOBBY`);
      } catch (e) {
        console.log(`RESET FALHOU: ${String(e).slice(0, 200)}`);
      }
    }
  }
});
