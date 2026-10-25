import { describe, expect, it, vi } from "vitest";
import {
  callChat,
  exceptionEvent,
  parseJsonObject,
} from "../../../supabase/functions/_shared/ai.ts";

const ok = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
  });
const messages = [{ role: "user", content: "x" }];

describe("callChat (Gemini via endpoint OpenAI-compatível)", () => {
  it("devolve o conteúdo na primeira tentativa", async () => {
    const fetchFn = vi.fn(async () => ok('{"definitions":["a"]}'));
    const r = await callChat({ fetchFn, apiKey: "k", messages });
    expect(r).toEqual({
      ok: true,
      content: '{"definitions":["a"]}',
      attempts: 1,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("tenta de novo após 5xx e recupera", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(ok("{}"));
    const r = await callChat({ fetchFn, apiKey: "k", messages, backoffMs: 1 });
    expect(r).toEqual({ ok: true, content: "{}", attempts: 2 });
  });

  it("429 persistente vira http_error com o status, após a nova tentativa", async () => {
    const fetchFn = vi.fn(async () => new Response("quota", { status: 429 }));
    const r = await callChat({ fetchFn, apiKey: "k", messages, backoffMs: 1 });
    expect(r).toEqual({
      ok: false,
      reason: "http_error",
      status: 429,
      attempts: 2,
    });
  });

  it("usa o endpoint do Google por padrão e aceita um alternativo", async () => {
    const fetchFn = vi.fn(async () => ok("{}"));
    await callChat({ fetchFn, apiKey: "k", messages });
    await callChat({
      fetchFn,
      apiKey: "k",
      messages,
      url: "http://127.0.0.1:9/chat",
    });
    expect(fetchFn.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      "http://127.0.0.1:9/chat",
    ]);
  });

  it("temperatura só vai no corpo quando informada (bots seguem no padrão do modelo)", async () => {
    const fetchFn = vi.fn(async (_u: string, _i: RequestInit) => ok("{}"));
    await callChat({ fetchFn, apiKey: "k", messages });
    await callChat({ fetchFn, apiKey: "k", messages, temperature: 0 });
    const bodies = fetchFn.mock.calls.map((c) =>
      JSON.parse(String((c as [string, RequestInit])[1].body)),
    );
    expect("temperature" in bodies[0]).toBe(false);
    expect(bodies[1].temperature).toBe(0);
  });

  it("4xx não transitório (401) não repete", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 401 }));
    const r = await callChat({ fetchFn, apiKey: "k", messages, backoffMs: 1 });
    expect(r).toMatchObject({
      ok: false,
      reason: "http_error",
      status: 401,
      attempts: 1,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("timeout aborta a requisição e é classificado como timeout", async () => {
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const r = await callChat({
      fetchFn,
      apiKey: "k",
      messages,
      timeoutMs: 15,
      retries: 0,
    });
    expect(r).toEqual({ ok: false, reason: "timeout", attempts: 1 });
  });

  it("erro de rede é classificado como network", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await callChat({ fetchFn, apiKey: "k", messages, retries: 0 });
    expect(r).toEqual({ ok: false, reason: "network", attempts: 1 });
  });

  it("corpo que não é JSON, ou sem conteúdo, é resposta inválida", async () => {
    const notJson = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await callChat({ fetchFn: notJson, apiKey: "k", messages })).toEqual(
      {
        ok: false,
        reason: "invalid_response",
        attempts: 1,
      },
    );
    const empty = vi.fn(async () => ok(""));
    expect(await callChat({ fetchFn: empty, apiKey: "k", messages })).toEqual({
      ok: false,
      reason: "invalid_response",
      attempts: 1,
    });
  });
});

describe("callChat com prazo total (deadlineMs — juiz do 🧠, 2026-10-24)", () => {
  // Gemini que só responde quando a tentativa é abortada (timeout).
  const hang = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  const run = async (opts: Parameters<typeof callChat>[0]) => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const p = callChat(opts);
      await vi.runAllTimersAsync();
      const r = await p;
      return { r, elapsed: Date.now() - t0 };
    } finally {
      vi.useRealTimers();
    }
  };

  it("cada tentativa usa só o que resta do prazo, e nenhuma começa sem tempo útil", async () => {
    const fetchFn = vi.fn(hang);
    const { r, elapsed } = await run({
      fetchFn,
      apiKey: "k",
      messages,
      timeoutMs: 8_000,
      retries: 3,
      deadlineMs: 10_000,
      minAttemptMs: 1_500,
    });
    // 8 s + espera de 0,7 s = sobra 1,3 s < 1,5 s → não abre a 2ª
    expect(r).toEqual({ ok: false, reason: "timeout", attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(elapsed).toBe(8_000);
  });

  it("a última tentativa é encurtada para caber no prazo", async () => {
    const fetchFn = vi.fn(hang);
    const { r, elapsed } = await run({
      fetchFn,
      apiKey: "k",
      messages,
      timeoutMs: 8_000,
      retries: 3,
      deadlineMs: 12_000,
      minAttemptMs: 1_500,
    });
    // 8 s + 0,7 s de espera → a 2ª só tem 3,3 s; termina no prazo exato
    expect(r).toEqual({ ok: false, reason: "timeout", attempts: 2 });
    expect(elapsed).toBe(12_000);
  });

  it("429: no máximo uma nova tentativa, mesmo com orçamento de sobra", async () => {
    const fetchFn = vi.fn(async () => new Response("quota", { status: 429 }));
    const { r } = await run({
      fetchFn,
      apiKey: "k",
      messages,
      retries: 3,
      deadlineMs: 17_000,
    });
    expect(r).toEqual({
      ok: false,
      reason: "http_error",
      status: 429,
      attempts: 2,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("onAttempt recebe o resultado de CADA tentativa (trilha da auditoria)", async () => {
    const seen: string[] = [];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockImplementationOnce(hang)
      .mockResolvedValueOnce(ok("{}"));
    const { r } = await run({
      fetchFn,
      apiKey: "k",
      messages,
      retries: 3,
      deadlineMs: 17_000,
      onAttempt: (a) => seen.push(a.ok ? "ok" : String(a.status ?? a.reason)),
    });
    expect(r).toEqual({ ok: true, content: "{}", attempts: 3 });
    expect(seen).toEqual(["503", "timeout", "ok"]);
  });

  it("sem deadlineMs nada muda (bots e Diário): 503, 503 → falha na 2ª", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(ok("{}"));
    const { r } = await run({ fetchFn, apiKey: "k", messages });
    expect(r).toEqual({
      ok: false,
      reason: "http_error",
      status: 503,
      attempts: 2,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("parseJsonObject", () => {
  it("tolera markdown em volta do JSON", () => {
    expect(parseJsonObject('```json\n{"matches":["1"]}\n```')).toEqual({
      matches: ["1"],
    });
  });
  it("devolve null para lixo, array ou null", () => {
    expect(parseJsonObject("sem json")).toBeNull();
    expect(parseJsonObject("[1,2]")).toBeNull();
    expect(parseJsonObject("null")).toBeNull();
  });
});

describe("exceptionEvent", () => {
  it("registra o ReferenceError que derrubou a geração, sem dados do jogo", () => {
    // mesma classe de bug de 27/07: identificador inexistente
    const err = new ReferenceError("norm is not defined");
    const ev = exceptionEvent("bot_ai_error", "bot-definitions", err, 12);
    expect(ev.kind).toBe("bot_ai_error");
    expect(ev.payload).toMatchObject({
      fn: "bot-definitions",
      reason: "exception",
      error_name: "ReferenceError",
      latency_ms: 12,
    });
    expect(Object.keys(ev.payload).sort()).toEqual(
      ["error_message", "error_name", "fn", "latency_ms", "reason"].sort(),
    );
  });
});
