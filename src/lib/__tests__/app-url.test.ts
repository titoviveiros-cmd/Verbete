import { describe, expect, it } from "vitest";
import { CANONICAL_APP_URL, resolveAppUrl, roomInviteUrl } from "../app-url";

describe("resolveAppUrl", () => {
  it("usa a URL configurada quando é https pública (sem barra final)", () => {
    expect(resolveAppUrl("https://jogo.verbete.workers.dev/")).toBe(
      "https://jogo.verbete.workers.dev",
    );
  });

  it.each([
    undefined,
    "",
    "   ",
    "não é url",
    "http://localhost:5173",
    "https://localhost",
    "capacitor://localhost",
    "http://jogo.verbete.workers.dev",
    "https://127.0.0.1:8080",
    "https://meu-pc.local",
  ])("cai na URL canônica para %j", (raw) => {
    expect(resolveAppUrl(raw)).toBe(CANONICAL_APP_URL);
  });

  it("a URL canônica é a de produção — nunca o domínio inexistente verbete.app", () => {
    expect(CANONICAL_APP_URL).toBe("https://jogo.verbete.workers.dev");
  });
});

describe("roomInviteUrl", () => {
  it("monta o deep link de convite com o código da sala", () => {
    expect(roomInviteUrl("1234")).toMatch(/^https:\/\/[^/]+\/\?join=1234$/);
    expect(roomInviteUrl("1234")).not.toMatch(/localhost|verbete\.app\//);
  });
});
