import { describe, it, expect } from "vitest";
import {
  normalizeForGame,
  sanitizeDefinition,
  sanitizeNickname,
  humanizeMeaning,
  wellFormedDefinition,
  revealsWord,
  definitionIssue,
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

describe("sanitizeDefinition (2.1.4: só normalização, nunca mascara)", () => {
  it("normaliza, colapsa espaços e corta no tamanho", () => {
    expect(sanitizeDefinition("  Livro   Antigo  ")).toBe("livro antigo");
    expect(sanitizeDefinition("x".repeat(200)).length).toBeLessThanOrEqual(140);
  });
  it("remove invisíveis e nunca insere asteriscos", () => {
    expect(sanitizeDefinition("pes​soa que guia")).toBe("pessoa que guia");
    expect(sanitizeDefinition("que PORRA é essa")).not.toContain("*");
    expect(sanitizeDefinition("veja https://x.com agora")).not.toContain(
      "[link]",
    );
  });
});

describe("revealsWord (anti-cola sem falso positivo)", () => {
  it("sala 5873: 'ciceronear' revela 'cicerone' (derivada que começa pela palavra)", () => {
    expect(
      revealsWord("pessoa responsável por ciceronear, coordenar", "cicerone"),
    ).toBe(true);
  });
  it.each([
    ["é a FAZEDA mesmo", "fazeda"],
    ["f.a.z.e.d.a demais", "fazeda"],
    ["fa-ze-da pura", "fazeda"],
    ["f a z e d a pura", "fazeda"],
    ["fa​zeda pura", "fazeda"],
    ["são as pindaíbas do sertão", "pindaíba"],
    ["Rapapé total", "rapapé"],
    ["um ad hoc qualquer", "ad hoc"],
  ])("pega a tentativa: %s", (t, w) => {
    expect(revealsWord(t, w)).toBe(true);
  });
  it.each([
    ["peixe amarelo e grande", "mar"],
    ["pessoa responsavel por guiar visitantes", "guia"],
    ["o ato de liderar outras pessoas", "lider"],
    ["tecido grosso usado nas velas", "teci"],
    ["cerimonia de mesuras na corte", "rapapé"],
    ["tecido de ab usado em velas", "ab"],
    ["marido ciumento", "mar"],
    ["carroça de madeira", "carro"],
  ])("não acusa texto legítimo: %s", (t, w) => {
    expect(revealsWord(t, w)).toBe(false);
  });
});

describe("definitionIssue (recusa clara em vez de mascarar)", () => {
  it("palavra da rodada, palavrão e link", () => {
    expect(definitionIssue("um cicerone de museu", "cicerone")).toBe(
      "reveals_word",
    );
    expect(definitionIssue("que porra é essa", "cicerone")).toBe(
      "blocked_word",
    );
    expect(definitionIssue("veja https://x.com", "cicerone")).toBe("link");
    expect(definitionIssue("veja www.x.com", "cicerone")).toBe("link");
  });
  it("texto legítimo com acento e pontuação passa", () => {
    expect(
      definitionIssue(
        "guia de turistas; conduz visitas, explica tudo!",
        "cicerone",
      ),
    ).toBeNull();
    expect(definitionIssue("pessoa que guia", "cicerone")).toBeNull();
  });
  it("chamado repetido não fica preso no estado do regex de link", () => {
    expect(definitionIssue("veja https://x.com", "zz")).toBe("link");
    expect(definitionIssue("veja https://x.com", "zz")).toBe("link");
    expect(definitionIssue("texto normal", "zz")).toBeNull();
  });
});

describe("wellFormedDefinition (texto da IA/reserva para a mesa)", () => {
  it("bem formado: devolve o texto sanitizado", () => {
    expect(
      wellFormedDefinition("Tipo de dança popular do interior do Brasil"),
    ).toBe("tipo de danca popular do interior do brasil");
  });
  it("quebrado (gagueira, corte, '(3)') é descartado", () => {
    expect(
      wellFormedDefinition("relativo a tecido tecido com fios metalicos finos"),
    ).toBeNull();
    expect(wellFormedDefinition("ferramenta usada para cortar o")).toBeNull();
    expect(
      wellFormedDefinition("danca tipica do interior do brasil (3)"),
    ).toBeNull();
  });
  it("descarta em vez de mascarar: palavra da rodada, palavrão e link", () => {
    expect(
      wellFormedDefinition("cerimonia de rapapes na corte antiga", "rapapé"),
    ).toBeNull();
    expect(
      wellFormedDefinition("lugar onde se fala merda o dia todo"),
    ).toBeNull();
    expect(
      wellFormedDefinition("pagina antiga em https://x.com/abc sobre festas"),
    ).toBeNull();
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
