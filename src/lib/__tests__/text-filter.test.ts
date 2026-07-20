import { describe, it, expect } from "vitest";
import {
  normalizeForGame,
  sanitizeDefinition,
  sanitizeNickname,
  humanizeMeaning,
} from "@/lib/text-filter";

describe("normalizeForGame", () => {
  it("minúsculas e sem acentos", () => {
    expect(normalizeForGame("Façécia É Rara")).toBe("facecia e rara");
  });
});

describe("sanitizeNickname", () => {
  it("remove símbolos e limita a 14 chars", () => {
    expect(sanitizeNickname("Tito<script>!!")).toBe("Titoscript");
    expect(sanitizeNickname("a".repeat(30))).toHaveLength(14);
  });
  it("preserva letras acentuadas, números, espaço, _ e -", () => {
    expect(sanitizeNickname("Zé_Tagarela-2")).toBe("Zé_Tagarela-2");
  });
  it("vazio vira Anônimo", () => {
    expect(sanitizeNickname("!!!")).toBe("Anônimo");
    expect(sanitizeNickname("   ")).toBe("Anônimo");
  });
});

describe("sanitizeDefinition", () => {
  it("normaliza, colapsa espaços e corta no tamanho", () => {
    expect(sanitizeDefinition("  Livro   Antigo  ")).toBe("livro antigo");
    expect(sanitizeDefinition("x".repeat(200)).length).toBeLessThanOrEqual(140);
  });
  it("substitui links", () => {
    expect(sanitizeDefinition("veja https://x.com/abc agora")).toBe(
      "veja [link] agora",
    );
  });
  it("censura palavrões com asteriscos", () => {
    expect(sanitizeDefinition("que PORRA é essa")).toBe("que ***** e essa");
  });

  describe("anti-cola da palavra da rodada", () => {
    it("ocorrência direta (com acento/maiúscula) vira ***", () => {
      const out = sanitizeDefinition("é a FAZEDA mesmo", 140, "fazeda");
      expect(out).not.toContain("fazeda");
      expect(out).toContain("***");
    });
    it("palavra separada por pontos é detectada", () => {
      const out = sanitizeDefinition("f.a.z.e.d.a demais", 140, "fazeda");
      expect(out.replace(/[^a-z0-9]/g, "")).not.toContain("fazeda");
      expect(out).toContain("***");
    });
    it("zero-width não disfarça a palavra", () => {
      const out = sanitizeDefinition("fa​zeda pura", 140, "fazeda");
      expect(out).not.toContain("fazeda");
    });
    it("plural/raiz é pego (pindaíbas ~ pindaíba)", () => {
      const out = sanitizeDefinition(
        "são as pindaibas do sertão",
        140,
        "pindaíba",
      );
      expect(out).not.toContain("pindaiba");
      expect(out).toContain("***");
    });
    it("texto inocente passa intacto", () => {
      expect(sanitizeDefinition("livro antigo e volumoso", 140, "fazeda")).toBe(
        "livro antigo e volumoso",
      );
    });
  });
});

describe("humanizeMeaning", () => {
  it("remove etiquetas de dicionário e fica na primeira acepção", () => {
    expect(humanizeMeaning("s.m. Livro antigo, volumoso; calhamaço.")).toBe(
      "livro antigo, volumoso",
    );
  });
  it("remove rótulo entre parênteses no início", () => {
    expect(humanizeMeaning("(Bras.) pessoa sem dinheiro")).toBe(
      "pessoa sem dinheiro",
    );
  });
  it("corta longos em limite de palavra e sem pontuação final", () => {
    const out = humanizeMeaning("palavra ".repeat(30), 90);
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out.endsWith("palavra")).toBe(true);
  });
});
