// Nome exibido sem o e-mail (Rodada 2B): o cadastro nunca manda o trecho do
// e-mail antes do @ e o login com Google não passa pelo formulário (o
// servidor também ignora name/full_name — scripts/test-data-retention.mjs).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY_NAME, signupDisplayName } from "@/lib/display-name";

const EMAIL = "maria.silva@exemplo.com";

describe("signupDisplayName", () => {
  it("sem nome → nada (o banco usa 'Jogador')", () => {
    expect(signupDisplayName("", EMAIL)).toBeUndefined();
    expect(signupDisplayName("   ", EMAIL)).toBeUndefined();
    expect(DEFAULT_DISPLAY_NAME).toBe("Jogador");
  });

  it("o trecho do e-mail nunca vira nome", () => {
    expect(signupDisplayName("maria.silva", EMAIL)).toBeUndefined();
    expect(signupDisplayName(" MARIA.SILVA ", EMAIL)).toBeUndefined();
    expect(signupDisplayName(EMAIL, EMAIL)).toBeUndefined();
    expect(signupDisplayName("ana+jogo", "ana+jogo@x.io")).toBeUndefined();
    expect(signupDisplayName("qualquer@coisa", EMAIL)).toBeUndefined();
  });

  it("nome escolhido passa, aparado e com no máximo 24 caracteres", () => {
    expect(signupDisplayName("  Mestre Verbete ", EMAIL)).toBe("Mestre Verbete");
    expect(signupDisplayName("Maria", EMAIL)).toBe("Maria");
    expect(signupDisplayName("x".repeat(40), EMAIL)).toBe("x".repeat(24));
  });

  it("login.tsx não deriva mais o nome do e-mail", () => {
    const src = readFileSync(join(__dirname, "../../routes/login.tsx"), "utf8");
    expect(src).not.toMatch(/email\.split\(\s*["']@["']\s*\)/);
    expect(src).toContain("signupDisplayName(displayName, email)");
  });
});
