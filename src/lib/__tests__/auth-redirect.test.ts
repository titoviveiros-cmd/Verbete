import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NATIVE_AUTH_CALLBACK,
  authRedirectFor,
  getAuthRedirectUrl,
} from "../auth-redirect";
import { CANONICAL_APP_URL } from "../app-url";

describe("retorno canônico da autenticação", () => {
  it("app nativo (WebView em https://localhost) volta pelo esquema próprio — nunca localhost", () => {
    const r = authRedirectFor({
      native: true,
      dev: false,
      origin: "https://localhost",
    });
    expect(r).toBe("app.verbete.game://auth/callback");
    expect(r).not.toMatch(/localhost/);
  });

  it("nativo ignora a origem mesmo em dev", () => {
    expect(
      authRedirectFor({
        native: true,
        dev: true,
        origin: "http://localhost:5173",
      }),
    ).toBe(NATIVE_AUTH_CALLBACK);
  });

  it("web em produção usa a própria origem pública", () => {
    expect(
      authRedirectFor({
        native: false,
        dev: false,
        origin: "https://jogo.verbete.workers.dev",
      }),
    ).toBe("https://jogo.verbete.workers.dev");
  });

  it("build de release servido em localhost cai na URL canônica (nunca localhost)", () => {
    for (const origin of [
      "https://localhost",
      "http://localhost:4173",
      "http://127.0.0.1:3000",
    ]) {
      expect(authRedirectFor({ native: false, dev: false, origin })).toBe(
        CANONICAL_APP_URL,
      );
    }
  });

  it("dev local mantém a origem do dev server", () => {
    expect(
      authRedirectFor({
        native: false,
        dev: true,
        origin: "http://localhost:5173",
      }),
    ).toBe("http://localhost:5173");
  });

  it("sem window (SSR) devolve a URL canônica", () => {
    expect(authRedirectFor({ native: false, dev: false, origin: null })).toBe(
      CANONICAL_APP_URL,
    );
  });

  it("no ambiente de teste (web) getAuthRedirectUrl não devolve o esquema nativo", () => {
    expect(getAuthRedirectUrl()).not.toBe(NATIVE_AUTH_CALLBACK);
  });
});

// Tripwire: nenhum fluxo de autenticação pode voltar a montar o retorno com a
// origem do WebView (no app ela é https://localhost).
describe("nenhum fluxo de auth usa window.location.origin como retorno", () => {
  const SRC = join(__dirname, "..", "..");
  const files: string[] = [];
  (function walk(d: string) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== "__tests__" && f !== "node_modules") walk(p);
      } else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
        files.push(p);
    }
  })(SRC);

  it("varre o código-fonte (sanidade do instrumento)", () => {
    expect(files.some((f) => f.endsWith(join("routes", "login.tsx")))).toBe(
      true,
    );
  });

  it("redirectTo/emailRedirectTo nunca recebem window.location.origin", () => {
    const bad = files.filter((f) =>
      /(redirectTo|emailRedirectTo)\s*:\s*window\.location\.origin/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(bad).toEqual([]);
  });

  it("login usa o retorno canônico nos dois fluxos (Google e cadastro por e-mail)", () => {
    const login = readFileSync(join(SRC, "routes", "login.tsx"), "utf8");
    expect(login).toMatch(/redirectTo:\s*getAuthRedirectUrl\(\)/);
    expect(login).toMatch(/emailRedirectTo:\s*getAuthRedirectUrl\(\)/);
  });
});
