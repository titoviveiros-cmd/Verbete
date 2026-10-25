import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HERO_CLASS,
  HERO_WORD_CLASS,
  OPTION_GRID_CLASS,
  OPTION_LG_TEXT_CLASS,
  OPTION_TEXT_CLASS,
  OPTION_WORD_CLASS,
  VOTE_BAR_CLASS,
  VOTE_TEXT_CLASS,
  VOTE_TIMER_CLASS,
  VOTE_WORD_CLASS,
} from "@/lib/word-fit";

// A escolha da palavra só aceita opções que cabem INTEIRAS no cartão da
// opção, no cartão grande da escrita e no cabeçalho da votação (lib/word-fit:
// probeLayouts monta essas vitrines com as classes abaixo). Se uma dessas
// telas mudar de classe e a medida não, palavras voltariam a cortar.
const src = (p: string) => readFileSync(p, "utf8");
const mobile = (cls: string) =>
  cls
    .split(/\s+/)
    .filter((t) => t && !t.startsWith("lg:"))
    .join(" ");

describe("word-fit mede as MESMAS vitrines que o jogo mostra", () => {
  it("cartão grande da palavra (WordCard): mesmas classes no celular", () => {
    const s = src("src/components/room/shared.tsx");
    expect(s).toContain('"word-hero text-center no-copy " +');
    expect(s).toContain('"px-4 py-3 lg:py-5"');
    expect(HERO_CLASS).toBe(
      mobile("word-hero text-center no-copy px-4 py-3 lg:py-5"),
    );
    // numa linha só: sem quebrar no hífen; no desktop estreito a palavra que
    // não cabe diminui o necessário (useFitOneLine) em vez de ser cortada
    expect(s).toContain(
      '"font-display text-stroke capitalize text-white mt-0.5 leading-tight whitespace-nowrap " +',
    );
    expect(s).toContain('"text-[34px] lg:text-[46px]"');
    expect(s).toContain("useFitOneLine(titleRef, word.word)");
    expect(s).toContain("ref={titleRef}");
    expect(HERO_WORD_CLASS).toBe(
      mobile(
        "font-display text-stroke capitalize text-white mt-0.5 leading-tight whitespace-nowrap text-[34px] lg:text-[46px]",
      ),
    );
  });

  it("cabeçalho da votação: palavra e relógio com as mesmas classes", () => {
    const s = src("src/components/room/phases/Voting.tsx");
    const bar =
      "word-hero shrink-0 flex items-center gap-3 px-4 py-2 lg:py-3 w-full max-w-full";
    const word =
      "font-display text-stroke text-2xl lg:text-3xl text-white leading-tight truncate capitalize";
    expect(s).toContain(`className="${bar}"`);
    expect(s).toContain('className="flex-1 min-w-0 no-copy"');
    expect(s).toContain(`className="${word}"`);
    expect(s).toContain(
      '"font-display tabular-nums text-4xl leading-none shrink-0 " +',
    );
    expect(VOTE_BAR_CLASS).toBe(mobile(bar));
    expect(VOTE_TEXT_CLASS).toBe("flex-1 min-w-0 no-copy");
    expect(VOTE_WORD_CLASS).toBe(mobile(word));
    expect(VOTE_TIMER_CLASS).toBe(
      "font-display tabular-nums text-4xl leading-none shrink-0",
    );
  });

  it("escolha: a categoria não divide a linha com a palavra se não couber", () => {
    const s = src("src/components/room/phases/ChooseWord.tsx");
    // a palavra e a categoria vivem num bloco que quebra linha (flex-wrap):
    // a categoria desce em vez de apertar a palavra
    expect(OPTION_TEXT_CLASS.split(" ")).toEqual(
      expect.arrayContaining(["flex", "flex-wrap", "min-w-0", "flex-1"]),
    );
    // a palavra entra na quebra com a largura dela: flex-1 (base 0) fazia a
    // categoria nunca descer — medido no navegador: 151 excluídas → 151
    expect(OPTION_WORD_CLASS.split(" ")).toContain("flex-auto");
    expect(OPTION_WORD_CLASS.split(" ")).not.toContain("flex-1");
    expect(s).toContain("${OPTION_TEXT_CLASS} ${OPTION_LG_TEXT_CLASS}");
    expect(s).toContain("className={OPTION_GRID_CLASS}");
    // desktop: empilhados, como antes
    expect(OPTION_LG_TEXT_CLASS).toContain("lg:flex-col");
    expect(OPTION_GRID_CLASS).toContain("lg:grid-cols-3");
  });
});
