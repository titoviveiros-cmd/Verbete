import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_EVAL_UNAVAILABLE,
  dailyFailureEvent,
  evaluateDailyGuess,
  runDailyEvaluation,
  type DailyEvalResult,
  type DailyFailureEvent,
} from "../daily-evaluation";
import {
  DAILY_BUDGET,
  DAILY_ID,
} from "../../../supabase/functions/_shared/semantic.ts";

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
  });
const scored = (n: number) =>
  ok(JSON.stringify({ scores: [{ id: DAILY_ID, score: n }] }));
const status = (s: number) => new Response("x", { status: s });

/** fetch que só termina quando a tentativa é abortada pelo timeout. */
const hang = () =>
  vi.fn(
    (_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener("abort", () =>
          rej(new DOMException("aborted", "AbortError")),
        );
      }),
  );

const base = {
  apiKey: "k",
  word: "w",
  truth: "t",
  guess: "g",
  now: () => Date.now(),
};

type EvalOpts = Parameters<typeof evaluateDailyGuess>[0];

/** Roda a avaliação com relógio falso, avançando até ela terminar. */
async function run(
  fetchFn: ReturnType<typeof vi.fn>,
  over: Partial<EvalOpts> = {},
): Promise<DailyEvalResult> {
  const p = evaluateDailyGuess({
    ...base,
    fetchFn: fetchFn as unknown as EvalOpts["fetchFn"],
    ...over,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  return p;
}

describe("Desafio Diário: novas tentativas e prazo (incidente de 03/11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("orçamento: no máximo 3 tentativas em 15 s", () => {
    expect(DAILY_BUDGET).toEqual({
      timeoutMs: 8_000,
      retries: 2,
      deadlineMs: 15_000,
    });
  });

  it("503 seguido de sucesso: nota válida na 2ª tentativa", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(scored(84));
    const r = await run(fetchFn);
    expect(r).toMatchObject({ ok: true, similarity: 84, attempts: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("503 persistente: para em 3 tentativas", async () => {
    const fetchFn = vi.fn(async () => status(503));
    const r = await run(fetchFn);
    expect(r).toMatchObject({
      ok: false,
      reason: "http_error",
      status: 503,
      attempts: 3,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("falha de rede seguida de sucesso também repete", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(scored(12));
    expect(await run(fetchFn)).toMatchObject({
      ok: true,
      similarity: 12,
      attempts: 2,
    });
  });

  it("429 persistente: no máximo 2 chamadas, com status no resultado", async () => {
    const fetchFn = vi.fn(async () => status(429));
    const r = await run(fetchFn);
    expect(r).toMatchObject({
      ok: false,
      reason: "http_error",
      status: 429,
      attempts: 2,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("timeout: o prazo total de 15 s é respeitado e a duração é medida", async () => {
    const fetchFn = hang();
    const r = await run(fetchFn);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("timeout");
    expect(r.attempts).toBe(2); // 8 s + espera + o que resta; não cabe a 3ª
    expect(r.latencyMs).toBeLessThanOrEqual(DAILY_BUDGET.deadlineMs);
    expect(r.latencyMs).toBeGreaterThanOrEqual(DAILY_BUDGET.deadlineMs - 100);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("chave Gemini ausente: não chama a IA e não vira nota 0", async () => {
    const fetchFn = vi.fn();
    expect(await run(fetchFn, { apiKey: undefined })).toEqual({
      ok: false,
      reason: "missing_key",
      attempts: 0,
      latencyMs: 0,
    });
    expect(await run(fetchFn, { apiKey: "" })).toMatchObject({
      ok: false,
      reason: "missing_key",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("definição sorteada ausente: falha (antes virava nota 0 e gastava a tentativa)", async () => {
    const fetchFn = vi.fn();
    expect(await run(fetchFn, { truth: "  " })).toMatchObject({
      ok: false,
      reason: "missing_truth",
      attempts: 0,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("resposta inválida (fora do formato ou corpo não-JSON): falha sem repetir", async () => {
    const semJson = vi.fn(async () => ok("sem json"));
    expect(await run(semJson)).toMatchObject({
      ok: false,
      reason: "invalid_response",
      attempts: 1,
    });
    const corpoRuim = vi.fn(
      async () => new Response("<html>", { status: 200 }),
    );
    expect(await run(corpoRuim)).toMatchObject({
      ok: false,
      reason: "invalid_response",
    });
    expect(semJson).toHaveBeenCalledTimes(1);
  });
});

describe("Desafio Diário: a tentativa só é gasta com nota", () => {
  const fail: DailyEvalResult = {
    ok: false,
    reason: "http_error",
    status: 503,
    attempts: 3,
    latencyMs: 2100,
  };

  it("falha: grava o evento, avisa o jogador e NÃO registra a tentativa", async () => {
    const record = vi.fn();
    const logEvent = vi.fn(async () => {});
    await expect(
      runDailyEvaluation({
        evaluate: async () => fail,
        record,
        logEvent,
        build: "abc1234",
      }),
    ).rejects.toThrow(DAILY_EVAL_UNAVAILABLE);
    expect(record).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith({
      kind: "judge_ai_error",
      build: "abc1234",
      payload: {
        fn: "daily",
        reason: "http_error",
        status: 503,
        attempts: 3,
        latency_ms: 2100,
      },
    });
  });

  it("falha ao gravar o evento não muda a resposta nem gasta a tentativa", async () => {
    const record = vi.fn();
    await expect(
      runDailyEvaluation({
        evaluate: async () => fail,
        record,
        logEvent: async () => {
          throw new Error("banco fora");
        },
        build: undefined,
      }),
    ).rejects.toThrow(DAILY_EVAL_UNAVAILABLE);
    expect(record).not.toHaveBeenCalled();
  });

  it("sucesso: registra com a nota da IA, sem evento de erro", async () => {
    const record = vi.fn(async (s: number) => ({ similarity: s }));
    const logEvent = vi.fn();
    const out = await runDailyEvaluation({
      evaluate: async () => ({
        ok: true,
        similarity: 91,
        attempts: 1,
        latencyMs: 800,
      }),
      record,
      logEvent,
      build: "abc1234",
    });
    expect(out).toEqual({ similarity: 91 });
    expect(record).toHaveBeenCalledWith(91);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("nota 0 legítima da IA é registrada (só a indisponibilidade não vira nota)", async () => {
    const record = vi.fn(async (s: number) => s);
    await runDailyEvaluation({
      evaluate: async () => ({
        ok: true,
        similarity: 0,
        attempts: 1,
        latencyMs: 10,
      }),
      record,
      logEvent: vi.fn(),
      build: null,
    });
    expect(record).toHaveBeenCalledWith(0);
  });
});

describe("Desafio Diário: evento sem dados pessoais", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SECRETS = {
    apiKey: "FAKE-gemini-key-0001",
    word: "PALAVRA-SORTEADA-XYZ",
    truth: "DEFINICAO-VERDADEIRA-XYZ",
    guess: "PALPITE-DO-JOGADOR Maria Souza maria@exemplo.com",
  };

  it("evento e log só têm campos técnicos — nada de palavra, definição, palpite ou chave", async () => {
    const events: DailyFailureEvent[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => status(429));
    const p = runDailyEvaluation({
      evaluate: () => evaluateDailyGuess({ fetchFn, ...SECRETS }),
      record: vi.fn(),
      logEvent: async (ev) => {
        events.push(ev);
      },
      build: "abc1234",
    });
    const settled = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await settled).toBeInstanceOf(Error);

    expect(events).toHaveLength(1);
    const [ev] = events;
    if (!ev) throw new Error("evento não gravado");
    expect(Object.keys(ev).sort()).toEqual(["build", "kind", "payload"]);
    expect(Object.keys(ev.payload).sort()).toEqual(
      ["attempts", "fn", "latency_ms", "reason", "status"].sort(),
    );
    const logged = JSON.stringify(ev) + JSON.stringify(warn.mock.calls);
    for (const s of Object.values(SECRETS)) expect(logged).not.toContain(s);
    expect(logged).not.toMatch(/maria|souza|FAKE-gemini/i);
    // a chave só vai para o Gemini, no cabeçalho
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.stringify(init.body)).not.toContain(SECRETS.apiKey);
    warn.mockRestore();
  });

  it("status só aparece quando existe; build ausente vira null", () => {
    expect(
      dailyFailureEvent(
        { ok: false, reason: "timeout", attempts: 2, latencyMs: 15000 },
        "",
      ),
    ).toEqual({
      kind: "judge_ai_error",
      build: null,
      payload: {
        fn: "daily",
        reason: "timeout",
        attempts: 2,
        latency_ms: 15000,
      },
    });
  });
});
