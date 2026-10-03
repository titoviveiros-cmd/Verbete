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
