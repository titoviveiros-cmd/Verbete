import { test, expect, type Page } from "@playwright/test";

// Validação pós-deploy (só com E2E_BASE_URL): 2 jogadores reais (com e sem
// 1 bot) jogam uma rodada completa no ambiente publicado — add_bot por RPC,
// bot escrevendo pela IA (lote do host), sugestões da IA, votação, revelação
// (pg_net → bônus 🧠) e placar. Se a tela de um jogador ficar presa na fase
// anterior enquanto a sala já avançou, o teste REGISTRA o travamento e
// recarrega a página (o F5 de um jogador) para validar o resto da rodada.
// No fim o host reseta a sala para o lobby: sala de teste largada em fase
// ativa vira laço do tick.
test.skip(!process.env.E2E_BASE_URL, "só contra um deploy (E2E_BASE_URL)");
test.setTimeout(540_000);

const NICK = "Ex: Bia, Zé, Dudu...";
const WRITE = "escreva sua definicao mirabolante...";
// textos bem diferentes: o servidor recusa definição parecida demais com outra
const BLUFFS = [
  "pequeno utensilio de ferro usado para moer graos",
  "danca tradicional de roda do litoral nordestino",
];

async function clickUntilVisible(
  page: Page,
  buttonName: RegExp,
  target: ReturnType<Page["locator"]>,
) {
  await expect(async () => {
    await page.getByRole("button", { name: buttonName }).click();
    await expect(target).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** Espera o alvo; se não vier em `soft` ms, registra travamento, recarrega e espera de novo. */
async function visibleOrReload(
  page: Page,
  name: string,
  target: () => ReturnType<Page["locator"]>,
  stalls: string[],
  soft = 30_000,
  hard = 90_000,
) {
  try {
    await expect(target()).toBeVisible({ timeout: soft });
  } catch {
    const screen = (
      await page
        .locator("main")
        .innerText()
        .catch(() => "")
    ).replace(/\s+/g, " ");
    stalls.push(
      `${name}: tela presa por ${soft / 1000}s — "${screen.slice(0, 160)}"`,
    );
    console.log(`TRAVAMENTO ${name}: ${screen.slice(0, 160)}`);
    await page.reload();
    await expect(target()).toBeVisible({ timeout: hard });
  }
}

for (const withBot of [false, true]) {
  test(`2 jogadores${withBot ? " + 1 bot" : ""} jogam uma rodada no deploy`, async ({
    browser,
  }) => {
    const tag = withBot ? "BOT" : "HUMANOS";
    // apelidos curtos: o campo corta em poucos caracteres
    const hostNick = withBot ? "Host B" : "Host H";
    const guestNick = withBot ? "Conv B" : "Conv H";
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();
    const names = new Map<Page, string>([
      [host, "host"],
      [guest, "convidado"],
    ]);
    const errors: string[] = [];
    const stalls: string[] = [];
    for (const [p, name] of names) {
      p.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
      p.on("console", (m) => {
        if (m.type() === "error")
          errors.push(`${name}: ${m.text().slice(0, 160)}`);
      });
    }

    let code = "";
    try {
      // 1) host cria a sala
      await host.goto("/");
      await clickUntilVisible(host, /Criar sala/, host.getByPlaceholder(NICK));
      await host.getByPlaceholder(NICK).fill(hostNick);
      await host.getByRole("button", { name: /Criar!/ }).click();
      await expect(host).toHaveURL(/\/room\/\d{4}/, { timeout: 30_000 });
      code = host.url().match(/room\/(\d{4})/)![1];
      console.log(`[${tag}] SALA ${code}`);

      // 2) convidado entra pela URL da sala
      await guest.goto(`/room/${code}`);
      await expect(guest.getByPlaceholder(NICK)).toBeVisible({
        timeout: 30_000,
      });
      await guest.getByPlaceholder(NICK).fill(guestNick);
      await guest.getByRole("button", { name: /Entrar na sala/ }).click();
      await expect(host.getByText(guestNick).first()).toBeVisible({
        timeout: 30_000,
      });

      // 3) bot (RPC add_bot) — o lobby passa a pedir só +1
      if (withBot) {
        await host.getByRole("button", { name: /\+1 Bot/ }).click();
        await expect(
          host.getByText(/Adicione \+1 jogador ou bot/).first(),
        ).toBeVisible({
          timeout: 30_000,
        });
        console.log(`[${tag}] BOT ADICIONADO`);
      }

      // 4) começa
      await host.getByRole("button", { name: /Começar/ }).click();

      // 5) coordenador: quem vê "Sortear palavra"; ninguém = o bot
      const pages: Page[] = [host, guest];
      let coord: Page | null = null;
      await expect(async () => {
        for (const p of pages) {
          if (
            await p
              .getByRole("button", { name: /Sortear palavra/ })
              .isVisible()
              .catch(() => false)
          )
            coord = p;
        }
        // sem humano com "Sortear palavra" e a escrita já aberta = o bot escolheu
        const writingOpen =
          (await host
            .getByPlaceholder(WRITE)
            .isVisible()
            .catch(() => false)) ||
          (await guest
            .getByPlaceholder(WRITE)
            .isVisible()
            .catch(() => false));
        expect(coord !== null || (withBot && writingOpen)).toBeTruthy();
      }).toPass({ timeout: 150_000 });
      console.log(`[${tag}] COORDENADOR ${coord ? names.get(coord) : "bot"}`);
      if (coord) {
        const c = coord as Page;
        // botões animados sem parar nunca ficam "estáveis" para o Playwright
        await c
          .getByRole("button", { name: /Sortear palavra/ })
          .click({ force: true });
        await c
          .locator("button.sticker")
          .first()
          .click({ timeout: 20_000, force: true });
      }

      // 6) quem não coordena escreve e envia (com confirmação)
      const writers = pages.filter((p) => p !== coord);
      for (const [i, w] of writers.entries()) {
        await visibleOrReload(
          w,
          names.get(w)!,
          () => w.getByPlaceholder(WRITE),
          stalls,
        );
        await expect(async () => {
          await w.getByPlaceholder(WRITE).fill(BLUFFS[i % BLUFFS.length], {
            timeout: 3_000,
          });
          await w
            .getByRole("button", { name: /Enviar definição/ })
            .click({ timeout: 3_000 });
          await expect(
            w.getByText(/Definição enviada!|Embaralhando as cédulas/).first(),
          ).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 60_000 });
      }
      console.log(`[${tag}] DEFINICOES ENVIADAS (${writers.length})`);

      // 7) votação: cada humano vota na primeira cédula habilitada
      for (const p of pages) {
        const cedula = () =>
          p.locator("button:has(span.text-sun):not([disabled])").first();
        await visibleOrReload(p, names.get(p)!, cedula, stalls, 90_000, 90_000);
        await cedula().click({ force: true });
      }
      console.log(`[${tag}] VOTOS ENVIADOS`);

      // 8) revelação → placar
      const marker = /Como cada um pontuou|Pontuação por equipe/;
      await visibleOrReload(
        host,
        "host",
        () => host.getByText(marker).first(),
        stalls,
        150_000,
        60_000,
      );
      await visibleOrReload(
        guest,
        "convidado",
        () => guest.getByText(marker).first(),
        stalls,
        60_000,
        60_000,
      );
      console.log(`[${tag}] PLACAR OK`);
    } finally {
      // 9) sem sala de teste em laço: o host reseta para o lobby
      if (code) {
        try {
          await host
            .getByRole("button", { name: "Resetar jogo" })
            .click({ timeout: 15_000 });
          await host
            .getByRole("button", { name: /Sim, resetar/ })
            .click({ timeout: 10_000 });
          await expect(
            host.getByRole("button", { name: /Começar|Mín\. 2/ }),
          ).toBeVisible({
            timeout: 30_000,
          });
          console.log(`[${tag}] SALA ${code} RESETADA PARA O LOBBY`);
        } catch (e) {
          console.log(`[${tag}] RESET FALHOU: ${String(e).slice(0, 200)}`);
        }
      }
      console.log(`[${tag}] TRAVAMENTOS: ${JSON.stringify(stalls)}`);
      console.log(
        `[${tag}] ERROS DO NAVEGADOR: ${JSON.stringify([...new Set(errors)].slice(0, 10))}`,
      );
      await hostCtx.close();
      await guestCtx.close();
    }
  });
}
