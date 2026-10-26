// Cartão grande da palavra (escrita) com palavras LONGAS do acervo (Red Team
// 2.1.2): no desktop de 1024 a ~1230 px a coluna da escrita é estreita e os
// 46 px cortavam o fim da palavra ("Desvanecim"). Agora a palavra fica
// INTEIRA numa linha: só a que não cabe na largura real diminui o necessário;
// a que cabe fica no tamanho da tela. Celular, deitado e desktop.
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock, type MockBackend } from "./supabase-mock";
import { ROOM_CODE, WORD, roomBackend, roomStorage } from "./fixtures";

const LONG = ["desvanecimento", "infundibuliforme", "compromissório"];
const VIEWPORTS: Array<[number, number]> = [
  [320, 568],
  [390, 844],
  [667, 375],
  [1024, 768],
  [1093, 615],
  [1180, 820],
  [1366, 768],
  [1920, 1080],
];
const SHOTS_DIR = process.env.SHOTS_DIR;

async function writing(page: Page, word: string, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  const backend = roomBackend("writing") as MockBackend;
  // a palavra chega pelo get_room_state E pela tabela words (no dev server o
  // StrictMode relê a tabela; no build de produção vale a do get_room_state)
  backend.tables["words"] = [{ ...WORD, word }];
  (backend.rpc["get_room_state"] as { word: unknown }).word = { ...WORD, word };
  await installSupabaseMock(page, backend);
  await page.addInitScript(
    (entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    },
    { "verbete:theme": "dark", ...roomStorage("writing") },
  );
  await page.goto(`/room/${ROOM_CODE}`);
  await expect(
    page.getByPlaceholder("escreva sua definicao mirabolante..."),
  ).toBeVisible({ timeout: 25_000 });
  await expect(page.locator(".word-hero h2", { hasText: word })).toBeVisible();
  await page.waitForTimeout(900); // mola do cartão
  return page.evaluate(() => {
    const h = document.querySelector<HTMLElement>(".word-hero h2")!;
    const card = h.closest(".word-hero")!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(h);
    const text = range.getBoundingClientRect();
    const font = parseFloat(getComputedStyle(h).fontSize);
    const inline = h.style.fontSize;
    h.style.fontSize = "";
    const cssFont = parseFloat(getComputedStyle(h).fontSize);
    h.style.fontSize = inline;
    return {
      cut: h.scrollWidth > h.clientWidth,
      inside: text.left >= card.left - 0.5 && text.right <= card.right + 0.5,
      oneLine: range.getClientRects().length === 1,
      font,
      cssFont,
    };
  });
}

for (const [w, h] of VIEWPORTS) {
  test(`cartão grande: palavra longa inteira numa linha @ ${w}x${h}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const seen: string[] = [];
    for (const word of LONG) {
      const r = await writing(page, word, w, h);
      seen.push(
        `${word} ${r.font}px${r.font < r.cssFont ? ` (de ${r.cssFont})` : ""}`,
      );
      expect(r.cut, `${word}: cortada`).toBe(false);
      expect(r.inside, `${word}: passa da borda do cartão`).toBe(true);
      expect(r.oneLine, `${word}: quebrou a linha`).toBe(true);
      // telas largas: cabe no tamanho da tela, sem diminuir à toa
      if (w >= 1366)
        expect(r.font, `${word}: diminuiu sem precisar`).toBe(r.cssFont);
      if (SHOTS_DIR && word === LONG[0])
        await page.screenshot({
          path: `${SHOTS_DIR}/escrita-longa-${w}x${h}.png`,
        });
    }
    // palavra curta: nunca diminui
    const short = await writing(page, WORD.word, w, h);
    expect(short.font, `${WORD.word}: diminuiu sem precisar`).toBe(
      short.cssFont,
    );
    console.log(
      `${w}x${h}: ${seen.join(" · ")} · ${WORD.word} ${short.font}px`,
    );
  });
}
