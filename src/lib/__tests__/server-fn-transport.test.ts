import { afterEach, describe, expect, it, vi } from "vitest";

// Funções de servidor no app nativo (RC Android 2.1.0): a chamada relativa
// /_serverFn/... caía no servidor local do WebView, que devolve o index.html
// com 200 — e o cliente REAL do TanStack aceitava isso como resultado
// ("Excluir conta" fazia logout sem excluir nada). Os testes usam o mesmo
// serverFnFetcher que o createClientRpc chama no app (importado pelo arquivo:
// o pacote só exporta o createClientRpc). Fora do navegador, as opções do
// Start vêm do contexto do servidor — o teste roda dentro de um contexto.
import { serverFnFetcher } from "../../../node_modules/@tanstack/start-client-core/dist/esm/client-rpc/serverFnFetcher.js";
import { runWithStartContext } from "@tanstack/start-storage-context";
import {
  assertServerFnResponse,
  expectOk,
  resolveServerFnUrl,
  serverFnFetch,
  ServerFnResponseError,
} from "@/lib/server-fn-transport";
import { serverFnsConfig } from "@/start";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const call = (fetchImpl: Fetch) =>
  runWithStartContext({ startOptions: {} } as never, () =>
    (
      serverFnFetcher as (
        url: string,
        args: unknown[],
        handler: Fetch,
      ) => Promise<unknown>
    )("/_serverFn/teste-fn", [{ data: {}, method: "POST" }], fetchImpl),
  );

const html = () =>
  new Response("<!doctype html><html><body>Verbete</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const json = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

afterEach(() => vi.unstubAllGlobals());

/** O caminho do app: serverFnFetch por cima do fetch do navegador. */
const callWith = (res: Response) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => res),
  );
  return call(serverFnFetch as Fetch);
};

describe("transporte das funções de servidor", () => {
  it("o app usa o transporte protegido em TODAS as funções (createStart)", () => {
    expect(serverFnsConfig.fetch).toBe(serverFnFetch);
  });

  it("defeito antigo reproduzido: com o fetch padrão, HTML 200 'dá certo'", async () => {
    const res = await call(async () => html());
    expect(res).toBeInstanceOf(Response); // a página vira o "resultado"
  });

  it("HTTP 200 + HTML (index.html do WebView) → ERRO, nunca sucesso", async () => {
    await expect(callWith(html())).rejects.toBeInstanceOf(
      ServerFnResponseError,
    );
  });

  it("200 + JSON inválido → erro", async () => {
    await expect(callWith(json("{nao é json"))).rejects.toBeInstanceOf(
      ServerFnResponseError,
    );
  });

  it("401 e 403 → erro com a mensagem do servidor", async () => {
    await expect(
      callWith(text("Unauthorized: No authorization header provided", 401)),
    ).rejects.toThrow(/Unauthorized/);
    await expect(callWith(text("Forbidden", 403))).rejects.toThrow(/Forbidden/);
  });

  it("500 (página de erro) → erro", async () => {
    await expect(
      callWith(
        new Response("<html>erro</html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("200 + JSON esperado → sucesso", async () => {
    await expect(callWith(json('{"ok":true}'))).resolves.toEqual({ ok: true });
  });

  it("aceita os outros formatos do protocolo (framed / ndjson)", async () => {
    for (const t of ["application/x-tss-framed", "application/x-ndjson"]) {
      const r = new Response("x", { headers: { "content-type": t } });
      await expect(assertServerFnResponse(r)).resolves.toBe(r);
    }
  });
});

describe("URL das funções de servidor", () => {
  it("site: mesma origem, caminho relativo intacto", () => {
    expect(resolveServerFnUrl("/_serverFn/abc", false)).toBe("/_serverFn/abc");
  });

  it("app nativo: URL absoluta do Worker público", () => {
    expect(
      resolveServerFnUrl(
        "/_serverFn/abc",
        true,
        "https://jogo.verbete.workers.dev",
      ),
    ).toBe("https://jogo.verbete.workers.dev/_serverFn/abc");
  });

  it("app nativo: nunca reescreve URL absoluta nem '//host'", () => {
    expect(resolveServerFnUrl("https://outro.example/x", true)).toBe(
      "https://outro.example/x",
    );
    expect(resolveServerFnUrl("//evil.example/x", true)).toBe(
      "//evil.example/x",
    );
  });
});

describe("resultado da operação", () => {
  it("só objeto simples com `ok: true` é sucesso — a Response (ok: true!) não", () => {
    expect(expectOk({ ok: true }, "x")).toEqual({ ok: true });
    for (const bad of [undefined, null, { ok: false }, {}, new Response("x")])
      expect(() => expectOk(bad as never, "falhou")).toThrow("falhou");
  });
});
