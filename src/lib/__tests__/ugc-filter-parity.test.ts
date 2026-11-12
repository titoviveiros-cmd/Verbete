import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFINITION_ISSUE_MESSAGE,
  UGC_BLOCKED,
  UGC_CONTACT_WORDS,
  definitionIssue,
  nicknameIssueMessage,
  ugcRejectedReason,
  ugcTextIssue,
  wellFormedDefinition,
} from "@/lib/text-filter";
import { AVATARS } from "@/lib/avatars";
import { UGC_CASES } from "../../../scripts/ugc-filter-cases.mjs";

// ECA Digital (11/11/2026): a regra do cliente e a do banco
// (public.ugc_text_issue) têm de ser a MESMA. O banco é conferido com os
// mesmos casos em scripts/test-ugc-filtro.mjs (CI, Supabase local).
const MIGRATION = readFileSync(
  "supabase/migrations/20261111120000_ugc_filtro_servidor.sql",
  "utf8",
);

function sqlArray(name: string): string[] {
  const m = new RegExp(`${name} text\\[\\] := ARRAY\\[([^\\]]*)\\]`).exec(
    MIGRATION,
  );
  if (!m) throw new Error(`lista ${name} não encontrada na migration`);
  return [...m[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
}

describe("paridade cliente × servidor (listas)", () => {
  it("palavrões: mesma lista, mesma ordem", () => {
    expect(sqlArray("v_blocked")).toEqual([...UGC_BLOCKED]);
  });
  it("palavras de contato: mesma lista, mesma ordem", () => {
    expect(sqlArray("v_contact")).toEqual([...UGC_CONTACT_WORDS]);
  });
  it("regex de telefone e de @ iguais às do servidor", () => {
    expect(MIGRATION).toContain(String.raw`'\d(?:[\s().-]*\d){7,}'`);
    expect(MIGRATION).toContain("'@[a-z0-9_]{2}'");
  });
  it("os gatilhos cobrem definição, apelido, nome exibido, avatares e reações", () => {
    expect(MIGRATION).toMatch(
      /BEFORE INSERT OR UPDATE OF text ON public\.definitions/,
    );
    expect(MIGRATION).toMatch(
      /BEFORE INSERT OR UPDATE OF nickname, avatar ON public\.players/,
    );
    expect(MIGRATION).toMatch(
      /BEFORE INSERT OR UPDATE OF display_name, avatar ON public\.profiles/,
    );
    expect(MIGRATION).toMatch(/BEFORE INSERT ON public\.reactions/);
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.ugc_text_issue\(text\) FROM PUBLIC, anon, authenticated/,
    );
  });
});

describe("avatares e reações do app são símbolos (o servidor recusa texto)", () => {
  // Mesma regra de public.ugc_symbol_issue: letra/dígito ASCII ou "@".
  const symbolIssue = (s: string) => /[A-Za-z0-9@]/.test(s);
  it("nenhum avatar da lista seria trocado pelo servidor", () => {
    for (const a of AVATARS) expect(symbolIssue(a)).toBe(false);
  });
  it("a regra está na migration", () => {
    expect(MIGRATION).toContain("~ '[A-Za-z0-9@]'");
  });
});

describe("ugcTextIssue (casos compartilhados com o banco)", () => {
  for (const [text, expected] of UGC_CASES) {
    it(`${JSON.stringify(text)} → ${expected}`, () => {
      expect(ugcTextIssue(text)).toBe(expected);
    });
  }
});

describe("definição", () => {
  it("palavra da rodada vem antes das outras regras", () => {
    expect(definitionIssue("cicerone no zapzap", "cicerone")).toBe(
      "reveals_word",
    );
  });
  it("contato é recusado com mensagem própria", () => {
    expect(definitionIssue("me chama 11987654321", "cicerone")).toBe("contact");
    expect(DEFINITION_ISSUE_MESSAGE.contact).toMatch(/telefone/);
  });
  it("texto de bot com contato é descartado (nunca vira cédula)", () => {
    expect(
      wellFormedDefinition("pessoa que manda o whatsapp para todos", "x"),
    ).toBeNull();
  });
});

describe("apelido e nome exibido", () => {
  it("apelido limpo passa", () => {
    expect(nicknameIssueMessage("Zé Tagarela")).toBeNull();
  });
  it("palavrão e contato são recusados com mensagem", () => {
    expect(nicknameIssueMessage("Porra Louca")).toMatch(/não é permitido/);
    expect(nicknameIssueMessage("Ana 11987654321")).toMatch(/nome real/);
  });
});

describe("ugcRejectedReason (erro do gatilho do servidor)", () => {
  it("lê o motivo do erro do Postgres", () => {
    expect(ugcRejectedReason({ message: "ugc_rejected:contact" })).toBe(
      "contact",
    );
    expect(ugcRejectedReason({ message: "ugc_rejected:blocked_word" })).toBe(
      "blocked_word",
    );
  });
  it("ignora outros erros", () => {
    expect(ugcRejectedReason({ message: "network down" })).toBeNull();
    expect(ugcRejectedReason(null)).toBeNull();
    expect(ugcRejectedReason({ message: "ugc_rejected:outro" })).toBeNull();
  });
});
