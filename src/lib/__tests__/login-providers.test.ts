// Diretriz 4.8 da App Store: sem "Entrar com a Apple", o app iOS não pode
// oferecer só o Google como login social. Web e Android não mudam.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  googleLoginAvailableOn,
  isGoogleLoginAvailable,
} from "../login-providers";

describe("provedores de login por plataforma", () => {
  it("Google fica de fora só no app iOS", () => {
    expect(googleLoginAvailableOn("ios")).toBe(false);
    expect(googleLoginAvailableOn("android")).toBe(true);
    expect(googleLoginAvailableOn("web")).toBe(true);
  });

  it("no ambiente de teste (web) o Google continua disponível", () => {
    expect(isGoogleLoginAvailable()).toBe(true);
  });

  it("a tela de login só desenha o botão do Google atrás da regra", () => {
    const src = readFileSync("src/routes/login.tsx", "utf8");
    const botao = src.indexOf("onClick={handleGoogle}");
    const guarda = src.indexOf("{googleLogin && (");
    expect(guarda).toBeGreaterThan(-1);
    expect(botao).toBeGreaterThan(guarda);
    // a divisória "ou com email" também some junto (sem Google não há "ou")
    expect(src.indexOf("ou com email")).toBeGreaterThan(guarda);
    expect(src.match(/handleGoogle\}/g)).toHaveLength(1);
  });
});
