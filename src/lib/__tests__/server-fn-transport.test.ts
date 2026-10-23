import { afterEach, describe, expect, it, vi } from "vitest";

// Funções de servidor no app nativo (RC Android 2.1.0). 1º defeito: a chamada
// relativa /_serverFn/... caía no servidor local do WebView, que devolve o
// index.html com 200 — e o cliente REAL do TanStack aceitava como resultado
// ("Excluir conta" fazia logout sem excluir nada). 2º defeito (Red Team, P0):
// fora da mesma origem o navegador esconde o x-tss-serialized sem o
// Access-Control-Expose-Headers, e o resultado virava o nó cru do
// serializador. Os testes usam o mesmo serverFnFetcher que o app chama
// (importado pelo arquivo; fora do navegador as opções do Start vêm do
// contexto do servidor — o teste roda dentro de um) e o corpo REAL do
// servidor (seroval, como o server-functions-handler).
import { serverFnFetcher } from "../../../node_modules/@tanstack/start-client-core/dist/esm/client-rpc/serverFnFetcher.js";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { toCrossJSONAsync } from "seroval";
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

/** Resposta como o Worker manda: seroval + x-tss-serialized. */
const serial = async (value: unknown, status = 200) =>
  new Response(JSON.stringify(await toCrossJSONAsync(value)), {
    status,
    headers: { "content-type": "application/json", "x-tss-serialized": "true" },
  });
/** A mesma resposta vista de outra origem SEM Expose-Headers (marca escondida). */
const hidden = async (res: Response) =>
  new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "" },
  });
const html = () =>
  new Response("<!doctype html><html><body>Verbete</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
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

  it("defeito do P0 reproduzido: marca escondida → o fetch padrão devolve o nó cru", async () => {
    const res = await call(async () => hidden(await serial({ ok: true })));
    expect(res).not.toEqual({ ok: true });
  });

  it("200 + resultado REAL do servidor → sucesso", async () => {
    await expect(callWith(await serial({ ok: true }))).resolves.toEqual({
      ok: true,
    });
  });

  it("P0: resultado com a marca escondida (CORS sem expor) → ERRO, nunca o nó cru", async () => {
    await expect(
      callWith(await hidden(await serial({ ok: true }))),
    ).rejects.toBeInstanceOf(ServerFnResponseError);
  });

  it("HTTP 200 + HTML (index.html do WebView) → ERRO, nunca sucesso", async () => {
    await expect(callWith(html())).rejects.toBeInstanceOf(
      ServerFnResponseError,
    );
  });

  it("content-type forjado (text/html; x=application/x-ndjson) → erro", async () => {
    await expect(
      callWith(
        new Response("<html></html>", {
          status: 200,
          headers: {
            "content-type": "text/html; x=application/x-ndjson",
            "x-tss-serialized": "true",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ServerFnResponseError);
  });

  it("200 + JSON inválido → erro (com ou sem a marca)", async () => {
    for (const headers of <Record<string, string>[]>[
      { "content-type": "application/json", "x-tss-serialized": "true" },
      { "content-type": "application/json" },
    ])
      await expect(
        callWith(new Response("{nao é json", { status: 200, headers })),
      ).rejects.toBeInstanceOf(ServerFnResponseError);
  });

  it("401 e 403 → erro com a mensagem do servidor", async () => {
    await expect(
      callWith(text("Unauthorized: No authorization header provided", 401)),
    ).rejects.toThrow(/Unauthorized/);
    await expect(callWith(text("Forbidden", 403))).rejects.toThrow(/Forbidden/);
  });

  it("500: página de erro OU erro serializado → erro (também com a marca escondida)", async () => {
    await expect(
      callWith(
        new Response("<html>erro</html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
      ),
    ).rejects.toThrow();
    const boom = () =>
      serial(new Error("Não foi possível excluir a conta."), 500);
    await expect(callWith(await boom())).rejects.toThrow(/excluir a conta/);
    await expect(callWith(await hidden(await boom()))).rejects.toBeInstanceOf(
      ServerFnResponseError,
    );
  });

  it("aceita os outros formatos marcados do protocolo (framed / ndjson)", async () => {
    for (const t of ["application/x-tss-framed", "application/x-ndjson"]) {
      const r = new Response("x", {
        headers: { "content-type": t, "x-tss-serialized": "true" },
      });
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
