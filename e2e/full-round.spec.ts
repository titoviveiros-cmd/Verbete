import { test, expect, type Page } from "@playwright/test";

// Partida multiplayer REAL: dois navegadores independentes (host + convidado)
// jogam uma rodada completa — criar sala, entrar pelo código, iniciar,
// coordenador sorteia e escolhe a palavra, escritor blefa, ambos votam,
// revelação e placar. Sem bots e sem tocar no banco: o teste se adapta a
// qualquer um dos dois ser sorteado coordenador.
//
// Determinismo da pontuação: com 2 jogadores a cédula tem 2 opções (verdade +
// blefe do escritor); o escritor não pode votar na própria → vota na verdade
// → o placar dele SEMPRE mostra "Acertou a verdade".
test.setTimeout(240_000);

const NICK_PLACEHOLDER = "Ex: Bia, Zé, Dudu...";

async function clickUntilVisible(
  page: Page,
  buttonName: RegExp,
  target: ReturnType<Page["locator"]>,
) {
  // SSR: o HTML chega antes da hidratação — repete o clique até surtir efeito.
  await expect(async () => {
    await page.getByRole("button", { name: buttonName }).click();
    await expect(target).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test("host + convidado jogam uma rodada completa", async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  // 1) Host cria a sala
  await host.goto("/");
  await clickUntilVisible(
    host,
    /Criar sala/,
    host.getByPlaceholder(NICK_PLACEHOLDER),
  );
  await host.getByPlaceholder(NICK_PLACEHOLDER).fill("E2E Host");
  await host.getByRole("button", { name: /Criar!/ }).click();
  await expect(host).toHaveURL(/\/room\/\d{4}/, { timeout: 20_000 });
  const code = host.url().match(/room\/(\d{4})/)![1];

  // 2) Convidado entra pela URL da sala (JoinFlow)
  await guest.goto(`/room/${code}`);
  await expect(guest.getByPlaceholder(NICK_PLACEHOLDER)).toBeVisible({
    timeout: 20_000,
  });
  await guest.getByPlaceholder(NICK_PLACEHOLDER).fill("E2E Guest");
  await guest.getByRole("button", { name: /Entrar na sala/ }).click();

  // 3) Ambos se veem no lobby
  await expect(host.getByText("E2E Guest").first()).toBeVisible({
    timeout: 25_000,
  });
  await expect(guest.getByText("E2E Host").first()).toBeVisible({
    timeout: 25_000,
  });

  // 4) Host inicia a partida
  await host.getByRole("button", { name: /Começar/ }).click();

  // 5) Fase de escolha: descobre quem foi sorteado coordenador
  const pages: Page[] = [host, guest];
  let coord: Page | undefined;
  await expect(async () => {
    for (const p of pages) {
      const visible = await p
        .getByRole("button", { name: /Sortear palavra/ })
        .isVisible()
        .catch(() => false);
      if (visible) coord = p;
    }
    expect(coord).toBeTruthy();
  }).toPass({ timeout: 40_000 });
  const writer = pages.find((p) => p !== coord)!;

  await coord!.getByRole("button", { name: /Sortear palavra/ }).click();
  // 3 cartas de palavra (classe sticker) — escolhe a primeira
  await coord!.locator("button.sticker").first().click({ timeout: 20_000 });

  // 6) Escritor blefa e envia — com retry e CONFIRMAÇÃO: o clique só conta
  //    quando a UI reage (enviada/embaralhando/votação). Sem isso, um fill
  //    preso em actionability deixava o jogo expulsar o escritor parado.
  const ta = writer.getByPlaceholder("escreva sua definicao mirabolante...");
  await expect(ta).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await ta.fill("definicao mirabolante do teste multiplayer", {
      timeout: 3_000,
    });
    await writer
      .getByRole("button", { name: /Enviar definição/ })
      .click({ timeout: 3_000 });
    await expect(
      writer
        .getByText(/Definição enviada|Embaralhando as cédulas|A palavra é/)
        .first(),
    ).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 45_000 });

  // 7) Votação (após o embaralhamento): cada um vota na primeira cédula
  //    habilitada — a do escritor está bloqueada para ele, então ele vota
  //    na verdade obrigatoriamente.
  for (const p of pages) {
    const cedula = p.locator("button:has(span.text-sun):not([disabled])");
    await expect(cedula.first()).toBeVisible({ timeout: 60_000 });
    await cedula.first().click();
  }

  // 8) Revelação (coreografia automática ~25s) → Placar de verdade.
  //    "Placar" sozinho aparece já na revelação ("📊 Placar em Ns");
  //    o subtítulo "Como cada um pontuou" só existe no Scoreboard.
  const scoreboardMarker = /Como cada um pontuou|Pontuação por equipe/;
  await expect(host.getByText(scoreboardMarker).first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(guest.getByText(scoreboardMarker).first()).toBeVisible({
    timeout: 120_000,
  });

  // 9) Pontuação congelada: o escritor votou na verdade → +3 no breakdown
  await expect(writer.getByText(/Acertou a verdade/).first()).toBeVisible({
    timeout: 20_000,
  });

  await hostCtx.close();
  await guestCtx.close();
});
