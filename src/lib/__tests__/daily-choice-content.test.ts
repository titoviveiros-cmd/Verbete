// D1 — critério 19 (validador) e o gerador de rascunhos a partir do acervo.
import { describe, expect, it } from "vitest";
import {
  draftDistractors,
  fnv1a,
  isPluralLead,
  leadShape,
  normalizeText,
  validateChoiceSet,
  type AcervoWord,
} from "../daily-choice-content";

const TRUTH = "Peixe de água doce, comum nos rios da Amazônia";

describe("critério 19 — validador de conteúdo", () => {
  it("conjunto bom passa", () => {
    const v = validateChoiceSet({
      word: "acará",
      truth: TRUTH,
      distractors: [
        "Instrumento de corda usado em festas do sertão",
        "Doença de pele que causa coceira intensa",
        "Tecido grosso de algodão usado em velas",
      ],
    });
    expect(v).toEqual({ ok: true, issues: [] });
  });

  it("reprova comprimento fora de 0,6–1,4× a definição certa", () => {
    const curto = "Ave pequena"; // 11 / 46 = 0,24
    const longo =
      "Ferramenta antiga de ferreiro usada para dobrar barras de metal quente na bigorna"; // > 1,4×
    const v = validateChoiceSet({
      word: "acará",
      truth: TRUTH,
      distractors: [curto, longo, "Doença de pele que causa coceira intensa"],
    });
    expect(v.ok).toBe(false);
    expect(
      v.issues.filter((i) => i.code === "comprimento").map((i) => i.index),
    ).toEqual([0, 1]);
  });

  it("limites exatos 0,6× e 1,4× são aceitos; logo fora, não", () => {
    const truth = "x".repeat(50);
    const mk = (n: number) => "y".repeat(n);
    expect(
      validateChoiceSet({
        word: "w",
        truth,
        distractors: [mk(30), mk(70), "z".repeat(50)],
      }).issues.filter((i) => i.code === "comprimento"),
    ).toEqual([]);
    const fora = validateChoiceSet({
      word: "w",
      truth,
      distractors: [mk(29), mk(71), "z".repeat(50)],
    });
    expect(
      fora.issues.filter((i) => i.code === "comprimento").map((i) => i.index),
    ).toEqual([0, 1]);
  });

  it("reprova distrator que é sinônimo/mesma raiz da correta", () => {
    const v = validateChoiceSet({
      word: "acará",
      truth: TRUTH,
      distractors: [
        "Peixe comum dos rios amazônicos de água doce",
        "Doença de pele que causa coceira intensa",
        "Tecido grosso de algodão usado em velas",
      ],
    });
    expect(v.issues.map((i) => [i.index, i.code])).toContainEqual([
      0,
      "sinonimo",
    ]);
  });

  it("reprova duplicado: igual à correta (sem acento/maiúscula) ou dois distratores iguais", () => {
    const v = validateChoiceSet({
      word: "acará",
      truth: TRUTH,
      distractors: [
        "PEIXE DE AGUA DOCE, COMUM NOS RIOS DA AMAZONIA",
        "Doença de pele que causa coceira intensa",
        "doença de pele que causa coceira intensa!",
      ],
    });
    const codes = v.issues.map((i) => [i.index, i.code]);
    expect(codes).toContainEqual([0, "duplicado"]);
    expect(codes).toContainEqual([2, "duplicado"]);
  });

  it("reprova distrator que contém a palavra do desafio", () => {
    const v = validateChoiceSet({
      word: "caramujo",
      truth: "Molusco terrestre de concha em espiral",
      distractors: [
        "Doce feito com caramujos e açúcar",
        "Tecido grosso de algodão usado",
        "Doença de pele que dá coceira",
      ],
    });
    expect(v.issues.map((i) => [i.index, i.code])).toContainEqual([
      0,
      "revela_palavra",
    ]);
  });

  it("reprova quantidade ≠ 3 e texto vazio", () => {
    expect(
      validateChoiceSet({ word: "w", truth: TRUTH, distractors: ["a", "b"] })
        .issues[0]!.code,
    ).toBe("quantidade");
    expect(
      validateChoiceSet({
        word: "w",
        truth: TRUTH,
        distractors: [
          "",
          "Doença de pele que causa coceira intensa",
          "Tecido grosso de algodão usado em velas",
        ],
      }).issues[0]!.code,
    ).toBe("vazio");
  });
});

describe("gerador de rascunhos (acervo, sem IA)", () => {
  const pool: AcervoWord[] = [
    { id: "t", word: "acará", meaning: TRUTH, classe: "substantivo" },
    {
      id: "a",
      word: "rabeca",
      meaning: "Instrumento de corda usado em festas do sertão",
      classe: "substantivo",
    },
    {
      id: "b",
      word: "sarna",
      meaning: "Doença de pele que causa coceira muito intensa",
      classe: "substantivo",
    },
    {
      id: "c",
      word: "lona",
      meaning: "Tecido grosso de algodão usado em velas e toldos",
      classe: "substantivo",
    },
    {
      id: "d",
      word: "cobreado",
      meaning: "Que tem a cor avermelhada do cobre polido",
      classe: "adjetivo",
    },
    {
      id: "e",
      word: "lambari",
      meaning: "Peixe pequeno de água doce dos rios brasileiros",
      classe: "substantivo",
    }, // mesma raiz: fora
    { id: "f", word: "ai", meaning: "Curto", classe: "substantivo" }, // curto demais: fora
    {
      id: "g",
      word: "pirão",
      meaning: "Papa grossa de farinha de mandioca com caldo de peixe",
      classe: "substantivo",
    },
  ];
  it("3 distratores válidos, de outras palavras, sem a raiz da correta, preferindo a mesma classe", () => {
    const d = draftDistractors(pool[0]!, pool);
    expect(d).not.toBeNull();
    expect(d).toHaveLength(3);
    expect(d!).not.toContain(TRUTH);
    expect(d!).not.toContain("Peixe pequeno de água doce dos rios brasileiros");
    expect(d!).not.toContain("Curto");
    expect(d!).not.toContain("Que tem a cor avermelhada do cobre polido"); // adjetivo perde para substantivos
    expect(
      validateChoiceSet({ word: "acará", truth: TRUTH, distractors: d! }).ok,
    ).toBe(true);
  });
  it("determinístico: mesma entrada, mesma saída (em qualquer ordem do acervo)", () => {
    const a = draftDistractors(pool[0]!, pool);
    const b = draftDistractors(pool[0]!, [...pool].reverse());
    expect(a).toEqual(b);
  });
  it("sem 3 candidatos bons = null (não inventa nada)", () => {
    expect(draftDistractors(pool[0]!, pool.slice(0, 3))).toBeNull();
  });
  it("auxiliares", () => {
    expect(normalizeText("  Ação, ÁGUA!  ")).toBe("acao agua");
    expect(leadShape("Que tem cor")).toBe("que");
    expect(leadShape("Andar devagar")).toBe("verbo");
    expect(isPluralLead("anulações totais de leis")).toBe(true);
    expect(isPluralLead("Que tem cor")).toBe(false);
    expect(isPluralLead("Peixe de rio")).toBe(false);
    expect(fnv1a("a")).toBe(fnv1a("a"));
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
  });
});
