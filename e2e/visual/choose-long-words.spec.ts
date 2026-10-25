// Escolha da palavra com palavras LONGAS reais do acervo (2026-10-24): antes,
// a categoria dividia a linha com a palavra e 151 de 1.080 ficavam de fora
// (ou viravam "Gastroenterol…"). Agora a categoria desce para a linha de
// baixo quando não cabe ao lado — e as 3 opções aparecem INTEIRAS: sem "…",
// palavra e categoria sem corte, nada vazando do cartão, sem rolagem lateral,
// de 320 a 430 px, com o celular deitado e no desktop (3 colunas).
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock, type MockBackend } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage } from "./fixtures";

// recuperadas nesta rodada (medidas no navegador com o CSS e a fonte reais)
const WORDS = [
  {
    id: "w_desv",
    word: "desvanecimento",
    category: "sentimento",
    rarity: 3,
    nivel: "dificil",
  },
  {
    id: "w_infund",
    word: "infundibuliforme",
    category: "adjetivo",
    rarity: 3,
    nivel: "insano",
  },
  {
    id: "w_compr",
    word: "compromissório",
    category: "direito",
    rarity: 3,
    nivel: "dificil",
  },
];
const VIEWPORTS: Array<[number, number]> = [
  [320, 568],
  [360, 800],
  [375, 812],
  [390, 844],
  [412, 915],
  [430, 932],
  [667, 375],
  [1366, 768],
];
const SHOTS_DIR = process.env.SHOTS_DIR;

async function drawWords(page: Page, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  const backend = roomBackend("choosing") as MockBackend;
  backend.rpc["get_random_word_prompts"] = WORDS;
  await installSupabaseMock(page, backend);
  await page.addInitScript(
    (entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    },
    { "verbete:theme": "dark", ...roomStorage("choosing") },
  );
  await page.goto(`/room/${ROOM_CODE}`);
  const draw = page.getByRole("button", { name: /Sortear palavra/ });
  await expect(draw).toBeVisible({ timeout: 25_000 });
  await draw.click({ force: true });
  for (const x of WORDS)
    await expect(page.getByText(x.word, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  await page.waitForTimeout(900); // mola das cartas
}

for (const [w, h] of VIEWPORTS) {
  test(`palavras longas inteiras na escolha @ ${w}x${h}`, async ({ page }) => {
    test.setTimeout(90_000);
    await drawWords(page, w, h);
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button.sticker")]
        .filter((b) => b.querySelector("p.capitalize"))
        .map((b) => {
          const p = b.querySelector<HTMLElement>("p.capitalize")!;
          const chip = b.querySelector<HTMLElement>(".chip");
          const r = (e: Element) => e.getBoundingClientRect();
          const card = r(b);
          return {
            word: p.textContent,
            wordCut: p.scrollWidth > p.clientWidth,
            fontScaled: p.style.fontSize !== "",
            chip: chip?.textContent ?? null,
            chipCut: chip ? chip.scrollWidth > chip.clientWidth : false,
            chipInside: chip
              ? r(chip).left >= card.left - 0.5 &&
                r(chip).right <= card.right + 0.5
              : true,
            chipBelow: chip ? r(chip).top >= r(p).bottom - 1 : false,
            cardOverflow: b.scrollWidth > b.clientWidth,
            cardInView: card.left >= -0.5 && card.right <= innerWidth + 0.5,
            height: Math.round(card.height),
          };
        }),
    );
    const pageOverflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - window.innerWidth;
    });
    console.log(
      `${w}x${h}: ` +
        cards
          .map(
            (c) =>
              `${c.word} (${c.chipBelow ? "categoria embaixo" : "categoria ao lado"}, ${c.height}px)`,
          )
          .join(" · "),
    );
    if (SHOTS_DIR)
      await page.screenshot({
        path: `${SHOTS_DIR}/escolha-longas-${w}x${h}.png`,
      });
    expect(cards, "3 opções").toHaveLength(3);
    expect(pageOverflow, "rolagem horizontal na página").toBeLessThanOrEqual(1);
    for (const c of cards) {
      expect(c.wordCut, `${c.word}: palavra cortada (…)`).toBe(false);
      expect(c.fontScaled, `${c.word}: fonte reduzida`).toBe(false);
      expect(c.chipCut, `${c.word}: categoria cortada`).toBe(false);
      expect(c.chipInside, `${c.word}: categoria fora do cartão`).toBe(true);
      expect(c.cardOverflow, `${c.word}: cartão vazando`).toBe(false);
      expect(c.cardInView, `${c.word}: cartão fora da tela`).toBe(true);
    }
    // a 320 px a categoria não cabe ao lado dessas palavras: desce
    if (w === 320)
      for (const c of cards)
        expect(c.chipBelow, `${c.word}: categoria embaixo a 320`).toBe(true);
  });
}
