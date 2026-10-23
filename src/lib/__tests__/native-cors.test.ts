import { describe, expect, it } from "vitest";
import { nativeCorsFor, withCors } from "@/lib/native-cors";

// CORS do Worker para o app nativo (RC Android 2.1.0): só a origem do
// WebView do Capacitor (https://localhost), só em /_serverFn/, sem curinga
// e sem credenciais — a autorização é o token Bearer de cada função.
const req = (method: string, path: string, origin?: string) =>
  new Request(`https://jogo.verbete.workers.dev${path}`, {
    method,
    headers: origin ? { origin } : {},
  });

describe("CORS do app nativo", () => {
  it("pré-voo do app em /_serverFn/: 204 só com a origem do app", () => {
    const c = nativeCorsFor(
      req("OPTIONS", "/_serverFn/abc", "https://localhost"),
    );
    expect(c.kind).toBe("preflight");
    if (c.kind !== "preflight") return;
    const h = c.response.headers;
    expect(c.response.status).toBe(204);
    expect(h.get("access-control-allow-origin")).toBe("https://localhost");
    expect(h.get("access-control-allow-headers")).toMatch(/authorization/);
    expect(h.get("access-control-allow-credentials")).toBeNull();
  });

  it("chamada do app: a resposta ganha a permissão de leitura + Vary", () => {
    const c = nativeCorsFor(req("POST", "/_serverFn/abc", "https://localhost"));
    expect(c).toEqual({
      kind: "headers",
      headers: {
        "Access-Control-Allow-Origin": "https://localhost",
        Vary: "Origin",
        "Access-Control-Expose-Headers": "x-tss-serialized, x-tss-raw",
      },
    });
  });

  it("outra origem → nada (nunca curinga)", () => {
    for (const o of ["https://evil.example", "http://localhost", "null"])
      expect(nativeCorsFor(req("OPTIONS", "/_serverFn/abc", o)).kind).toBe(
        "none",
      );
  });

  it("páginas do site e chamadas sem Origin (mesma origem) → nada muda", () => {
    expect(nativeCorsFor(req("GET", "/", "https://localhost")).kind).toBe(
      "none",
    );
    expect(nativeCorsFor(req("POST", "/_serverFn/abc")).kind).toBe("none");
  });

  it("withCors preserva status/corpo e acrescenta ao Vary existente", async () => {
    const r = withCors(
      new Response("{}", { status: 401, headers: { vary: "Accept-Encoding" } }),
      { "Access-Control-Allow-Origin": "https://localhost", Vary: "Origin" },
    );
    expect(r.status).toBe(401);
    expect(await r.text()).toBe("{}");
    expect(r.headers.get("vary")).toBe("Accept-Encoding, Origin");
  });
});
