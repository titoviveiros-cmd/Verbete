import { describe, expect, it, vi } from "vitest";
import { drawFittingWords, type WordFit } from "@/lib/word-fit";
import type { Word } from "@/lib/room";

// Escolha da palavra: as 3 opções aparecem INTEIRAS (teste real: a tela
// mostrou "Gastroenterol…"). A seleção pede candidatas a mais e só fica com as
// que cabem no cartão de 288 px (pior caso, 320 px); a medida real é do DOM
// (lib/word-fit.ts: measureWordFit) — aqui ela é simulada por comprimento.
const W = (word: string): Word =>
  ({ id: word, word, category: null, rarity: 2 }) as Word;
const AVAIL = 130; // px úteis simulados para a palavra
const PX = 11; // px por letra simulados
const measure = async (ws: Word[]) =>
  new Map<string, WordFit>(
    ws.map((w) => {
      const need = w.word.length * PX;
      return [w.id, { fits: need <= AVAIL, need, avail: AVAIL }];
    }),
  );

describe("drawFittingWords", () => {
  it("só oferece palavras que cabem, na ordem sorteada", async () => {
    const fetch = vi.fn(async () =>
      [
        "melancolia",
        "gastroenterologista",
        "enfiteuta",
        "anticonstitucional",
        "zarabatana",
      ].map(W),
    );
    const r = await drawFittingWords({ fetch, measure });
    expect(r.words.map((w) => w.word)).toEqual([
      "melancolia",
      "enfiteuta",
      "zarabatana",
    ]);
    expect(r.scale).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sorteia de novo, sem repetir as já vistas, quando faltam opções que cabem", async () => {
    const batches = [
      ["gastroenterologista", "melancolia", "anticonstitucional"],
      ["otorrinolaringologia", "enfiteuta", "zarabatana"],
    ];
    const fetch = vi.fn(async (seen: string[]) =>
      (batches.shift() ?? []).map(W).filter((w) => !seen.includes(w.id)),
    );
    const r = await drawFittingWords({ fetch, measure });
    expect(r.words.map((w) => w.word)).toEqual([
      "melancolia",
      "enfiteuta",
      "zarabatana",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toEqual([
      "gastroenterologista",
      "melancolia",
      "anticonstitucional",
    ]);
  });

  it("para depois do limite de tentativas (nada de laço infinito)", async () => {
    const fetch = vi.fn(async () => [W("otorrinolaringologista")]);
    await drawFittingWords({ fetch, measure, attempts: 3 });
    expect(fetch).toHaveBeenCalledTimes(2); // 2ª volta só traz repetida → para
    const many = vi.fn(async (seen: string[]) => [
      W(`palavramuitolonga${seen.length}`),
    ]);
    await drawFittingWords({ fetch: many, measure, attempts: 3 });
    expect(many).toHaveBeenCalledTimes(3);
  });

  it("último recurso (acervo mínimo): completa com as mais curtas, com escala que faz caber — nunca reticências", async () => {
    const fetch = vi.fn(async (seen: string[]) =>
      seen.length
        ? []
        : [
            "melancolia",
            "anticonstitucionalissimamente",
            "gastroenterologista",
          ].map(W),
    );
    const r = await drawFittingWords({ fetch, measure });
    expect(r.words.map((w) => w.word)).toEqual([
      "melancolia",
      "gastroenterologista",
      "anticonstitucionalissimamente",
    ]);
    expect(r.scale.melancolia).toBeUndefined();
    expect(r.scale.gastroenterologista).toBeCloseTo(AVAIL / (19 * PX));
    for (const id of Object.keys(r.scale)) expect(r.scale[id]).toBeLessThan(1);
  });

  it("nunca mais de 3 nem palavras repetidas", async () => {
    const fetch = vi.fn(async () =>
      ["um", "um", "dois", "um", "tres", "quatro"].map(W),
    );
    const r = await drawFittingWords({ fetch, measure });
    expect(r.words.map((w) => w.word)).toEqual(["um", "dois", "tres"]);
  });
});
