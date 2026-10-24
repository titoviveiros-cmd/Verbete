import { test, expect } from "@playwright/test";
import {
  OPTION_CHIP_CLASS,
  OPTION_CLASS,
  OPTION_ICON_CLASS,
  OPTION_WORD_CLASS,
  WORST_CASE_OPTION_WIDTH,
} from "../src/lib/word-fit";

// Escolha da palavra (teste real: "Gastroenterol…"). Com o CSS e a fonte
// REAIS do alvo, o cartão da opção montado com as MESMAS classes do app:
// a 288 px (tela de 320) "gastroenterologia" não cabe e é excluída; palavras
// do caso real cabem; e quem cabe a 288 px não trunca em nenhuma largura de
// 320 a 430 px. Contra o site ou o bundle nativo.
test.skip(!process.env.E2E_BASE_URL, "só com E2E_BASE_URL");
test.use({ ignoreHTTPSErrors: true });

// categorias REAIS do acervo (o chip divide a linha com a palavra: "melancolia"
// + "SENTIMENTO" passa 2 px a 320 px e fica de fora — medido em 24/10)
const WORDS: Array<[string, string, boolean]> = [
  ["gastroenterologia", "medicina", false],
  ["otorrinolaringologia", "medicina", false],
  ["carrapicho-de-carneiro", "planta", false],
  ["melancolia", "sentimento", false],
  ["enfiteuta", "direito", true],
  ["fleuma", "sentimento", true],
];
const WIDTHS: Record<number, number> = {
  320: 288,
  360: 328,
  375: 343,
  390: 358,
  412: 380,
  430: 398,
};

test("cartão da opção: mede o texto real; quem cabe a 320 px nunca trunca", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await document.fonts.load("700 22px Fredoka");
    await document.fonts.ready;
  });
  const fitsAt = (width: number) =>
    page.evaluate(
      ({ width, words, C }) => {
        const box = document.createElement("div");
        box.style.cssText = `position:fixed;left:-20000px;top:0;visibility:hidden;width:${width}px`;
        const ps = words.map(([word, category]) => {
          const row = document.createElement("div");
          row.className = C.option;
          const i = document.createElement("span");
          i.className = C.icon;
          i.textContent = "📖";
          const p = document.createElement("p");
          p.className = C.word;
          p.textContent = word;
          const c = document.createElement("span");
          c.className = C.chip;
          c.textContent = category;
          row.append(i, p, c);
          box.append(row);
          return p;
        });
        document.body.append(box);
        const r = ps.map((p) => p.scrollWidth <= p.clientWidth);
        box.remove();
        return r;
      },
      {
        width,
        words: WORDS.map(([w, c]) => [w, c]),
        C: {
          option: OPTION_CLASS,
          icon: OPTION_ICON_CLASS,
          word: OPTION_WORD_CLASS,
          chip: OPTION_CHIP_CLASS,
        },
      },
    );
  const worst = await fitsAt(WORST_CASE_OPTION_WIDTH);
  console.log(
    `a 288 px: ${WORDS.map(([w], i) => `${w}=${worst[i] ? "cabe" : "não cabe"}`).join(", ")}`,
  );
  expect(worst).toEqual(WORDS.map(([, , fits]) => fits));
  for (const [vw, w] of Object.entries(WIDTHS)) {
    const at = await fitsAt(w);
    WORDS.forEach(([word], i) => {
      if (worst[i]) expect(at[i], `${word} @${vw}px`).toBe(true);
    });
  }
});
