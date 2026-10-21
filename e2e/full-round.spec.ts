import { test, expect, type Page } from "@playwright/test";
import { BOT_FAKE_DEFINITIONS_TEMPLATES } from "../src/lib/bot-names";
import { normalizeForGame, sanitizeDefinition } from "../src/lib/text-filter";

// Partida multiplayer REAL: dois navegadores independentes (host + convidado)
// jogam uma rodada completa — criar sala, entrar pelo código, iniciar,
// coordenador sorteia e escolhe a palavra, escritor blefa, ambos votam,
// revelação e placar. Mesa mínima de 4: o host completa com 2 bots (sem tocar no banco): o teste se adapta a
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

  // 4) Mínimo de 4 participantes (2º playtest 2026-10-20): o host completa a
  //    mesa com bots e só então inicia.
  await expect(
    host.getByRole("button", { name: /Mín\. 4 jogadores/ }),
  ).toBeDisabled();
  await host.getByRole("button", { name: /Encher até 4/ }).click();
  await expect(host.getByText("Jogadores (4/12)")).toBeVisible({
    timeout: 25_000,
  });
  await host.getByRole("button", { name: /Começar/ }).click();

  // 5) Fase de escolha: coordenador humano (vê "Sortear palavra") ou bot (a
  //    escrita abre sozinha para os dois humanos).
  const pages: Page[] = [host, guest];
  let coord: Page | undefined;
  await expect(async () => {
    coord = undefined;
    for (const p of pages) {
      const visible = await p
        .getByRole("button", { name: /Sortear palavra/ })
        .isVisible()
        .catch(() => false);
      if (visible) coord = p;
    }
    const writingOpen = await host
      .getByPlaceholder("escreva sua definicao mirabolante...")
      .isVisible()
      .catch(() => false);
    expect(!!coord || writingOpen).toBeTruthy();
  }).toPass({ timeout: 40_000 });
  if (coord) {
    await coord.getByRole("button", { name: /Sortear palavra/ }).click();
    // 3 cartas de palavra (classe sticker) — escolhe a primeira
    await coord.locator("button.sticker").first().click({ timeout: 20_000 });
  }
  const writers = pages.filter((p) => p !== coord);
  const writer = writers[0]!;

  // 6) Escritores blefam e enviam — com retry e CONFIRMAÇÃO: o clique só conta
  //    quando a UI reage (enviada/embaralhando/votação).
  const BLUFFS = [
    "definicao mirabolante do teste multiplayer",
    "outra definicao inventada pelo convidado",
  ];
  for (const [i, w] of writers.entries()) {
    const ta = w.getByPlaceholder("escreva sua definicao mirabolante...");
    await expect(ta).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await ta.fill(BLUFFS[i]!, { timeout: 3_000 });
      await w
        .getByRole("button", { name: /Enviar definição/ })
        .click({ timeout: 3_000 });
      await expect(
        w
          .getByText(/Definição enviada|Embaralhando as cédulas|A palavra é/)
          .first(),
      ).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
  }

  // 7) Votação: o escritor acha a VERDADE por eliminação — não é blefe de
  //    humano nem reserva de bot (no CI os bots usam as reservas locais);
  //    os demais votam na primeira cédula habilitada.
  const norm = (s: string) =>
    normalizeForGame(s)
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const known = new Set([
    ...BLUFFS.map(norm),
    ...BOT_FAKE_DEFINITIONS_TEMPLATES.map((t) =>
      norm(sanitizeDefinition(t, 140)),
    ),
  ]);
  for (const p of pages) {
    const cedulas = p.locator("button:has(.token):not([disabled])");
    await expect(cedulas.first()).toBeVisible({ timeout: 60_000 });
    let alvo = cedulas.first();
    if (p === writer) {
      const n = await cedulas.count();
      for (let i = 0; i < n; i++) {
        const txt = norm(await cedulas.nth(i).innerText());
        const texto = txt.replace(/^[a-z] /, ""); // tira a letra da ficha
        if (![...known].some((k) => k && texto.includes(k))) {
          alvo = cedulas.nth(i);
          break;
        }
      }
    }
    await alvo.click();
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
