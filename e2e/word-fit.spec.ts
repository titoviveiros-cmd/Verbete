import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  PROBE_CLASSES,
  probeLayouts,
  WORST_CASE_OPTION_WIDTH,
  type ProbeResult,
} from "../src/lib/word-fit";

// Escolha da palavra (teste real: "Gastroenterol…"). Com o CSS e a fonte
// REAIS do alvo, a MESMA função de medida do app (probeLayouts) roda no
// navegador: o cartão da opção (a categoria desce para a linha de baixo
// quando não cabe ao lado da palavra), o cartão grande da escrita (34 px) e
// o cabeçalho da votação (24 px + relógio). Contra o site, o bundle nativo
// ou o dev server (WORDFIT_LOCAL=1).
test.skip(
  !process.env.E2E_BASE_URL && !process.env.WORDFIT_LOCAL,
  "só com E2E_BASE_URL ou WORDFIT_LOCAL=1",
);
test.use({ ignoreHTTPSErrors: true });

// categorias REAIS do acervo. Antes (chip na mesma linha), "melancolia" +
// SENTIMENTO passava 2 px a 320 px e ficava de fora.
const WORDS: Array<[string, string, boolean]> = [
  ["gastroenterologia", "medicina", false], // não cabe no cartão grande (34 px)
  ["otorrinolaringologia", "medicina", false],
  ["carrapicho-de-carneiro", "planta", false],
  ["melancolia", "sentimento", true], // recuperada
  ["desvanecimento", "sentimento", true], // recuperada
  ["blefaroplastia", "medicina", true], // recuperada
  ["enfiteuta", "direito", true],
  ["fleuma", "sentimento", true],
];
// largura útil = tela − 32 px do .mobile-shell
const WIDTHS: Record<number, number> = {
  320: 288,
  360: 328,
  375: 343,
  390: 358,
  412: 380,
  430: 398,
};
// desktop: largura REAL da grade das 3 opções (coluna da fase ao lado da
// mesa; a 1024 px a moldura de 1 px deixa 586 — medido no app pelo Red Team)
const LG_GRID: Record<number, number> = { 1024: 586, 1280: 820 };

type W = { id: string; word: string; category: string | null };
const fonts = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.load("700 22px Fredoka");
    await document.fonts.ready;
    return document.fonts.check("700 22px Fredoka");
  });
const probe = (page: Page, words: W[], width: number, lgGridWidth?: number) =>
  page.evaluate(probeLayouts, { words, width, lgGridWidth, C: PROBE_CLASSES });
const allOk = (r: ProbeResult) => r.option.ok && r.hero.ok && r.vote.ok;

test("as 3 vitrines medem o texto real; quem cabe a 320 px nunca corta até 430 px", async ({
  page,
}) => {
  await page.goto("/");
  expect(await fonts(page), "fonte Fredoka carregada").toBe(true);
  const words = WORDS.map(([word, category]) => ({ id: word, word, category }));
  const worst = await probe(page, words, WORST_CASE_OPTION_WIDTH);
  console.log(
    `a 288 px: ${worst
      .map((r) =>
        allOk(r)
          ? `${r.id}=cabe`
          : `${r.id}=não cabe (${[
              !r.option.ok && "opção",
              !r.hero.ok && "cartão grande",
              !r.vote.ok && "votação",
            ]
              .filter(Boolean)
              .join("+")})`,
      )
      .join(", ")}`,
  );
  expect(worst.map(allOk)).toEqual(WORDS.map(([, , fits]) => fits));
  // a categoria nunca é o motivo: no cartão da opção, todas cabem agora
  for (const r of worst)
    expect(r.option.ok, `${r.id}: cartão da opção`).toBe(
      r.id !== "carrapicho-de-carneiro",
    );
  for (const [vw, w] of Object.entries(WIDTHS)) {
    const at = await probe(page, words, w);
    at.forEach((r, i) => {
      if (allOk(worst[i]!)) expect(allOk(r), `${r.id} @${vw}px`).toBe(true);
    });
  }
});

// Acervo inteiro: WORDFIT_POOL=<json [{word,category}]> WORDFIT_OUT=<saída>.
test("acervo inteiro (WORDFIT_POOL)", async ({ page }) => {
  test.skip(!process.env.WORDFIT_POOL, "só com WORDFIT_POOL");
  test.setTimeout(180_000);
  const raw = JSON.parse(readFileSync(process.env.WORDFIT_POOL!, "utf8"));
  const rows: Array<{ word: string; category: string | null }> =
    raw.rows ?? raw;
  const words = rows.map((r, i) => ({
    id: String(i),
    word: r.word,
    category: r.category,
  }));
  // viewport de desktop: as variantes lg: valem para a grade de 3 colunas
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  expect(await fonts(page), "fonte Fredoka carregada").toBe(true);
  const worst = await probe(page, words, WORST_CASE_OPTION_WIDTH);
  const byWidth: Record<string, { cut: number; fitAt320ButCut: number }> = {};
  for (const [vw, w] of Object.entries(WIDTHS)) {
    const at = await probe(page, words, w);
    byWidth[vw] = {
      cut: at.filter((r) => !allOk(r)).length,
      fitAt320ButCut: at.filter((r, i) => allOk(worst[i]!) && !allOk(r)).length,
    };
    expect(byWidth[vw]!.fitAt320ButCut, `quem cabe a 320 corta a ${vw}`).toBe(
      0,
    );
  }
  const desktop: Record<string, number> = {};
  for (const [vw, g] of Object.entries(LG_GRID)) {
    const at = await probe(page, words, WORST_CASE_OPTION_WIDTH, g);
    desktop[vw] = at.filter((r) => allOk(r) && r.lg && !r.lg.ok).length;
  }
  const excluded = worst
    .map((r, i) => ({
      word: rows[i]!.word,
      category: rows[i]!.category,
      why: [
        !r.option.ok && "opção",
        !r.hero.ok && "cartão grande",
        !r.vote.ok && "votação",
      ].filter(Boolean),
      need: { option: r.option.need, hero: r.hero.need, vote: r.vote.need },
    }))
    .filter((e) => e.why.length);
  const fitLens = rows
    .filter((_, i) => allOk(worst[i]!))
    .map((r) => [...r.word].length);
  const out = {
    total: rows.length,
    excluded: excluded.length,
    longestFitting: Math.max(...fitLens),
    byWidth,
    desktopExtraExcluded: desktop,
    list: excluded,
  };
  if (process.env.WORDFIT_OUT)
    writeFileSync(process.env.WORDFIT_OUT, JSON.stringify(out, null, 1));
  console.log(
    `acervo ${out.total}: não cabem ${out.excluded} · maior que cabe ${out.longestFitting} letras · ` +
      `por largura ${JSON.stringify(byWidth)} · desktop (só a mais) ${JSON.stringify(desktop)}`,
  );
});
