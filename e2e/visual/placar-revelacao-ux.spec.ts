// Placar / revelação / Diário (testes reais em Android, 2026-10-25), sem
// backend (Supabase simulado), em 320/360/375/390/412/430 px:
//   • placar: o valor "→ +X pt(s)" nunca quebra no meio; nenhum card estoura
//     (nomes de 14 caracteres, vários critérios, lista de enganados); o 🧠
//     tem destaque próprio só em quem chegou perto da verdade;
//   • revelação: o card da verdade mostra a MESMA letra da cédula da votação;
//     o selo "Chegou perto da verdade" fica no blefe certo, nunca na verdade;
//   • Diário: o "Como calculamos" sumiu, sem buraco no lugar.
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import {
  LONG_NAMES,
  R3_NEAR,
  R3_TRUTH,
  ROOM_CODE,
  dailyBackend,
  roomBackend,
  roomStorage,
} from "./fixtures";

const WIDTHS = [320, 360, 375, 390, 412, 430];

async function openRoom(
  page: Page,
  phase: "voting" | "reveal" | "scoreboard",
  opts: { longNames?: boolean; guest?: boolean } = {},
) {
  await page.setViewportSize({ width: WIDTHS[0]!, height: 844 });
  await installSupabaseMock(page, roomBackend(phase, opts));
  await page.addInitScript(
    (entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    },
    roomStorage(phase, { guest: opts.guest }),
  );
  await page.goto(`/room/${ROOM_CODE}`);
}

const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

// SHOTS_DIR=… salva as capturas de cada largura para revisão visual
const shot = (page: Page, name: string) =>
  process.env.SHOTS_DIR
    ? page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png` })
    : Promise.resolve();

for (const longNames of [false, true]) {
  test(`placar ${longNames ? "com apelidos de 14 caracteres" : "padrão"}: valor nunca quebra, nada estoura, 🧠 só em quem chegou perto`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openRoom(page, "scoreboard", { longNames });
    await expect(
      page.getByRole("button", { name: /Próxima rodada/ }),
    ).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator("li.chip [data-points]").first()).toBeVisible();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(700);
      const r = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".sticker")].filter((c) =>
          c.querySelector("li.chip"),
        );
        const out = {
          cards: cards.length,
          chips: 0,
          brokenPoints: [] as string[],
          outside: [] as string[],
          near: [] as string[],
        };
        for (const card of cards) {
          const box = card.getBoundingClientRect();
          const name =
            card.querySelector(".font-display.text-xl")?.textContent ?? "?";
          for (const li of card.querySelectorAll("li")) {
            const b = li.getBoundingClientRect();
            if (b.left < box.left - 0.5 || b.right > box.right + 0.5)
              out.outside.push(`${name}: ${li.textContent?.slice(0, 40)}`);
          }
          for (const chip of card.querySelectorAll("li.chip")) {
            out.chips++;
            const pts = chip.querySelector("[data-points]");
            // uma caixa de linha só = o "→ +3 pts" não quebrou
            if (pts && pts.getClientRects().length !== 1)
              out.brokenPoints.push(`${name}: ${chip.textContent}`);
            if (chip.getAttribute("data-near-truth") === "1")
              out.near.push(`${name}: ${chip.textContent}`);
          }
        }
        return out;
      });
      console.log(
        `placar @${width}${longNames ? " (14 car.)" : ""}: ${r.cards} cards, ${r.chips} linhas, quebradas=${r.brokenPoints.length}, fora=${r.outside.length}, 🧠=${JSON.stringify(r.near)}`,
      );
      await shot(page, `placar-${longNames ? "14car" : "padrao"}-${width}`);
      expect(await pageOverflow(page), `rolagem lateral @${width}`).toBe(0);
      expect(r.brokenPoints, `"pts" sozinho @${width}`).toEqual([]);
      expect(r.outside, `card estourado @${width}`).toEqual([]);
      // 🧠: rodada 2 (Zé) e rodada 3 (Nina) — e mais ninguém
      const zé = longNames ? LONG_NAMES["p_ze004"]! : "Zé";
      const nina = longNames ? LONG_NAMES["p_nina5"]! : "Nina";
      expect(r.near.sort()).toEqual(
        [
          `${nina}: 🧠 Chegou perto da verdade 1× → +3 pts`,
          `${zé}: 🧠 Chegou perto da verdade 1× → +3 pts`,
        ].sort(),
      );
    }
  });
}

test("revelação: a verdade mostra a letra da cédula; o selo 🧠 fica no blefe certo", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  // 1) a letra da verdade na VOTAÇÃO (mesma fonte: definitions.letter)
  const voting = await browser.newPage();
  await openRoom(voting, "voting", { guest: true });
  const ballot = voting.locator("button.sticker", { hasText: R3_TRUTH.text });
  await expect(ballot).toBeVisible({ timeout: 30_000 });
  const ballotLetter = (await ballot.locator(".token").innerText()).trim();
  await voting.close();
  expect(ballotLetter).toBe(R3_TRUTH.letter);

  // 2) a revelação (convidado: este navegador não avança a fase)
  await openRoom(page, "reveal", { guest: true });
  const truthLetter = page.locator("[data-truth-letter]").first();
  await expect(truthLetter).toBeVisible({ timeout: 30_000 });
  expect((await truthLetter.innerText()).trim()).toBe(ballotLetter);
  const near = page.locator('[data-near-truth="1"]');
  await expect(near.first()).toBeVisible({ timeout: 30_000 });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(600);
    const r = await page.evaluate(
      ({ nearText, truthText }) => {
        const tags = [...document.querySelectorAll('[data-near-truth="1"]')];
        const where = tags.map((t) => {
          const card = t.closest("li") ?? t.parentElement!;
          const box = card.getBoundingClientRect();
          const b = t.getBoundingClientRect();
          return {
            inNearCard: (card.textContent ?? "").includes(nearText),
            inTruthCard: (card.textContent ?? "").includes(truthText),
            inside: b.left >= box.left - 0.5 && b.right <= box.right + 0.5,
            ptsLines:
              t.querySelector(".whitespace-nowrap")?.getClientRects().length ??
              0,
            text: (t.textContent ?? "").trim(),
          };
        });
        const letter = document.querySelector("[data-truth-letter]");
        return { where, letter: letter?.textContent?.trim() ?? null };
      },
      { nearText: R3_NEAR.text, truthText: R3_TRUTH.text },
    );
    console.log(
      `revelação @${width}: letra=${r.letter} selos=${JSON.stringify(r.where)}`,
    );
    await shot(page, `revelacao-${width}`);
    if (process.env.SHOTS_DIR)
      await near
        .first()
        .locator("xpath=ancestor::li[1]")
        .screenshot({
          path: `${process.env.SHOTS_DIR}/revelacao-selo-${width}.png`,
        });
    expect(await pageOverflow(page), `rolagem lateral @${width}`).toBe(0);
    expect(r.letter).toBe(ballotLetter);
    expect(r.where).toHaveLength(1);
    expect(r.where[0]).toMatchObject({
      inNearCard: true,
      inTruthCard: false,
      inside: true,
      ptsLines: 1,
      text: "🧠 Chegou perto da verdade+3 pts",
    });
  }
});

test("Diário: o resultado não tem mais o 'Como calculamos' (nem buraco no lugar)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: WIDTHS[0]!, height: 844 });
  await installSupabaseMock(page, dailyBackend("result"));
  await page.goto("/daily");
  const truth = page.getByText("Significado correto", { exact: false }).first();
  await expect(truth).toBeVisible({ timeout: 30_000 });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(400);
    await shot(page, `diario-${width}`);
    expect(await page.getByText("Como calculamos").count()).toBe(0);
    expect(await page.locator("details").count()).toBe(0);
    expect(await pageOverflow(page), `rolagem lateral @${width}`).toBe(0);
  }
});
