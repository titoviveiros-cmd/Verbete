import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn() },
}));

const { DEFAULT_STORE_URL, evaluateGate, nativeBuildNumber } =
  await import("../remote-config");

const app = (nativeBuild: number | null) => ({ native: true, nativeBuild });
const web = { native: false, nativeBuild: null };

describe("evaluateGate (versão mínima / manutenção remotas)", () => {
  it("sem configuração (servidor fora, erro, timeout) nunca bloqueia", () => {
    expect(evaluateGate(null, app(2))).toEqual({ kind: "ok" });
    expect(evaluateGate({}, app(2))).toEqual({ kind: "ok" });
  });

  it("APK abaixo da versão mínima vê a tela de atualização", () => {
    expect(evaluateGate({ min_native_build: "3" }, app(2))).toEqual({
      kind: "update",
      storeUrl: DEFAULT_STORE_URL,
    });
  });

  it("APK na versão mínima ou acima segue normal", () => {
    expect(evaluateGate({ min_native_build: "2" }, app(2))).toEqual({
      kind: "ok",
    });
    expect(evaluateGate({ min_native_build: "2" }, app(5))).toEqual({
      kind: "ok",
    });
  });

  it("versão mínima não afeta o web (que se atualiza sozinho)", () => {
    expect(evaluateGate({ min_native_build: "99" }, web)).toEqual({
      kind: "ok",
    });
  });

  it("APK sem número de versão conhecido não é bloqueado (falha aberta)", () => {
    expect(evaluateGate({ min_native_build: "3" }, app(null))).toEqual({
      kind: "ok",
    });
  });

  it("usa o link de loja configurado só se for https", () => {
    expect(
      evaluateGate(
        { min_native_build: "3", store_url: "https://example.com/app" },
        app(2),
      ),
    ).toEqual({ kind: "update", storeUrl: "https://example.com/app" });
    expect(
      evaluateGate(
        { min_native_build: "3", store_url: "javascript:alert(1)" },
        app(2),
      ),
    ).toEqual({ kind: "update", storeUrl: DEFAULT_STORE_URL });
  });

  it("manutenção bloqueia web e app, com mensagem padrão ou configurada", () => {
    expect(evaluateGate({ maintenance: "on" }, web)).toMatchObject({
      kind: "maintenance",
    });
    expect(
      evaluateGate(
        { maintenance: "ON", maintenance_message: "Volto às 15h" },
        app(9),
      ),
    ).toEqual({
      kind: "maintenance",
      message: "Volto às 15h",
    });
    expect(evaluateGate({ maintenance: "off" }, web)).toEqual({ kind: "ok" });
  });

  it("nativeBuildNumber só aceita inteiro positivo", () => {
    expect(nativeBuildNumber("2")).toBe(2);
    expect(nativeBuildNumber(undefined)).toBeNull();
    expect(nativeBuildNumber("dev")).toBeNull();
    expect(nativeBuildNumber("0")).toBeNull();
  });
});
