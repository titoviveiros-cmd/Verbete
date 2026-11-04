import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_EVAL_UNAVAILABLE,
  dailyEvent,
  dailyFailureEvent,
  evaluateDailyGuess,
  runDailyEvaluation,
  type DailyEvalResult,
  type DailyFailureEvent,
} from "../daily-evaluation";
import {
  DAILY_BUDGET,
  DAILY_ID,
  DAILY_MODELS,
} from "../../../supabase/functions/_shared/semantic.ts";
import { GEMINI_MODEL } from "../../../supabase/functions/_shared/ai.ts";

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

  it("orçamento: 3 tentativas de 5 s, sem espera entre modelos, em 15 s", () => {
    expect(DAILY_BUDGET).toEqual({
      timeoutMs: 5_000,
      retries: 2,
      deadlineMs: 15_000,
      backoffMs: 0,
    });
    // três timeouts seguidos cabem no prazo (a 3ª tentativa acontece)
    expect(
      (DAILY_BUDGET.retries + 1) * DAILY_BUDGET.timeoutMs +
        DAILY_BUDGET.backoffMs * 3,
    ).toBeLessThanOrEqual(DAILY_BUDGET.deadlineMs);
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
    expect(r.attempts).toBe(3); // 5 s + 5 s + 5 s, sem espera
    expect(r.latencyMs).toBeLessThanOrEqual(DAILY_BUDGET.deadlineMs);
    expect(r.latencyMs).toBeGreaterThanOrEqual(DAILY_BUDGET.deadlineMs - 100);
    expect(fetchFn).toHaveBeenCalledTimes(3);
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

  it("sucesso: registra com a nota da IA e grava só o evento de SUCESSO", async () => {
    const record = vi.fn(async (s: number) => ({ similarity: s }));
    const logEvent = vi.fn(async () => {});
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
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith({
      kind: "judge_ai_success",
      build: "abc1234",
      payload: {
        fn: "daily",
        attempts: 1,
        latency_ms: 800,
      },
    });
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
      logEvent: vi.fn(async () => {}),
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
      [
        "attempts",
        "fn",
        "latency_ms",
        "model",
        "reason",
        "status",
        "tries",
      ].sort(),
    );
    expect(ev.payload.model).toBe(DAILY_MODELS[1]);
    expect(String(ev.payload.tries)).toMatch(
      /^flash-lite-latest:429:\d+,3\.5-flash:429:\d+$/,
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
    // sem chamada à IA (sem chave ou sem definição): sem modelo
    expect(
      dailyFailureEvent(
        { ok: false, reason: "missing_key", attempts: 0, latencyMs: 0 },
        "b",
      ).payload,
    ).toEqual({
      fn: "daily",
      reason: "missing_key",
      attempts: 0,
      latency_ms: 0,
    });
  });
});

describe("Desafio Diário: cadeia de modelos e trilha por tentativa (incidente de 04/11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const bodyModel = (fetchFn: ReturnType<typeof vi.fn>, i = 0): unknown =>
    JSON.parse(
      String(
        (fetchFn.mock.calls[i] as unknown as [string, RequestInit])[1].body,
      ),
    ).model;

  it("1ª tentativa no MESMO modelo do multiplayer; as seguintes em versões fixas", async () => {
    expect(DAILY_MODELS[0]).toBe(GEMINI_MODEL);
    expect(DAILY_MODELS).toHaveLength(DAILY_BUDGET.retries + 1);
    for (const m of DAILY_MODELS.slice(1)) {
      expect(m).not.toMatch(/latest/);
      expect(m).not.toBe(GEMINI_MODEL);
    }
    expect(new Set(DAILY_MODELS).size).toBe(DAILY_MODELS.length);
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await run(fetchFn);
    expect([0, 1, 2].map((i) => bodyModel(fetchFn, i))).toEqual([
      ...DAILY_MODELS,
    ]);
  });

  it("modelo saudável na 1ª: uma chamada só, no modelo do multiplayer", async () => {
    const fetchFn = vi.fn(async () => scored(88));
    const r = await run(fetchFn);
    expect(r).toMatchObject({ ok: true, similarity: 88, attempts: 1 });
    expect(bodyModel(fetchFn)).toBe(GEMINI_MODEL);
    expect(dailyEvent(r, "b").payload.model).toBe(GEMINI_MODEL);
  });

  it("503 e depois sucesso: troca de modelo e trilha com modelo, resultado e duração", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(scored(84));
    const r = await run(fetchFn);
    expect(r.ok).toBe(true);
    expect(r.tries?.map((x) => [x.model, x.result])).toEqual([
      [DAILY_MODELS[0], "503"],
      [DAILY_MODELS[1], "ok"],
    ]);
    const p = dailyEvent(r, "b").payload;
    expect(p.tries).toMatch(/^flash-lite-latest:503:\d+,3\.5-flash:ok:\d+$/);
    expect(p.model).toBe(DAILY_MODELS[1]); // quem deu a nota
  });

  it("timeout no 1º modelo e resposta no 2º: a nota chega dentro do prazo", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(hang())
      .mockResolvedValueOnce(scored(91));
    const r = await run(fetchFn);
    expect(r).toMatchObject({ ok: true, similarity: 91, attempts: 2 });
    expect(r.tries?.[0]).toMatchObject({
      result: "timeout",
      ms: DAILY_BUDGET.timeoutMs,
    });
    expect(r.latencyMs).toBeLessThan(DAILY_BUDGET.deadlineMs);
  });

  it("timeout persistente: os 3 modelos são tentados e cada um registra a duração", async () => {
    const fetchFn = hang();
    const r = await run(fetchFn);
    expect(r.ok).toBe(false);
    expect(r.tries?.map((x) => [x.model, x.result])).toEqual([
      [DAILY_MODELS[0], "timeout"],
      [DAILY_MODELS[1], "timeout"],
      [DAILY_MODELS[2], "timeout"],
    ]);
    const ms = r.tries?.map((x) => x.ms) ?? [];
    expect(ms.slice(0, 2)).toEqual([5_000, 5_000]);
    // a 3ª recebe o que resta do prazo (cada troca de modelo consome ~1 ms)
    expect(ms[2]).toBeGreaterThan(4_990);
    expect(ms[2]).toBeLessThanOrEqual(5_000);
    expect([0, 1, 2].map((i) => bodyModel(fetchFn, i))).toEqual([
      ...DAILY_MODELS,
    ]);
    expect(r.latencyMs).toBeLessThanOrEqual(DAILY_BUDGET.deadlineMs);
    expect(dailyEvent(r, "b").payload).toMatchObject({
      reason: "timeout",
      attempts: 3,
      model: DAILY_MODELS[2],
    });
  });

  it("dois timeouts e nota no 3º modelo: a nota chega dentro dos 15 s", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(hang())
      .mockImplementationOnce(hang())
      .mockImplementationOnce(async () => {
        await new Promise((res) => setTimeout(res, 3_000)); // 3º modelo responde em 3 s
        return scored(83);
      });
    const r = await run(fetchFn);
    expect(r).toMatchObject({ ok: true, similarity: 83, attempts: 3 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(13_000);
    expect(r.latencyMs).toBeLessThan(13_010);
    expect(r.latencyMs).toBeLessThanOrEqual(DAILY_BUDGET.deadlineMs);
    expect(bodyModel(fetchFn, 2)).toBe(DAILY_MODELS[2]);
    expect(dailyEvent(r, "b").payload).toMatchObject({
      attempts: 3,
      model: DAILY_MODELS[2],
    });
    expect(dailyEvent(r, "b").payload.tries).toMatch(
      /^flash-lite-latest:timeout:5000,3\.5-flash:timeout:5000,3\.1-flash-lite:ok:300\d$/,
    );
  });

  it("dois timeouts e o 3º modelo lento demais: corta no prazo global, sem nota", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(hang())
      .mockImplementationOnce(hang())
      .mockImplementationOnce(hang());
    const r = await run(fetchFn);
    expect(r).toMatchObject({ ok: false, reason: "timeout", attempts: 3 });
    expect(r.latencyMs).toBeLessThanOrEqual(DAILY_BUDGET.deadlineMs);
  });

  it("perto do corte: a nota do modelo de reserva passa intacta (o corte de 80 é o do SQL)", async () => {
    for (const n of [79, 80, 81]) {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(hang())
        .mockImplementationOnce(hang())
        .mockResolvedValueOnce(scored(n));
      const r = await run(fetchFn);
      expect(r).toMatchObject({ ok: true, similarity: n });
      // mesmo prompt e temperatura em todos os modelos; só o modelo muda
      const bodies = [0, 1, 2].map((i) =>
        JSON.parse(
          String(
            (fetchFn.mock.calls[i] as unknown as [string, RequestInit])[1].body,
          ),
        ),
      );
      for (const b of bodies.slice(1)) {
        expect(b.messages).toEqual(bodies[0].messages);
        expect(b.temperature).toBe(bodies[0].temperature);
      }
    }
  });

  it("Gemini indisponível (rede caída persistente): 3 tentativas e falha, sem nota", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await run(fetchFn);
    expect(r).toMatchObject({ ok: false, reason: "network", attempts: 3 });
    expect(r.tries?.map((x) => x.result)).toEqual([
      "network",
      "network",
      "network",
    ]);
  });

  it("erro 500 persistente: 3 tentativas, uma por modelo, com o status", async () => {
    const r = await run(vi.fn(async () => status(500)));
    expect(r).toMatchObject({
      ok: false,
      reason: "http_error",
      status: 500,
      attempts: 3,
    });
    expect(dailyEvent(r, null).payload.tries).toMatch(
      /^flash-lite-latest:500:\d+,3\.5-flash:500:\d+,3\.1-flash-lite:500:\d+$/,
    );
  });
});

describe("Desafio Diário: erro ao gravar o evento no Supabase", () => {
  it("insert com { error } vira aviso só com o código; a tentativa segue não gasta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const record = vi.fn();
    await expect(
      runDailyEvaluation({
        evaluate: async () => ({
          ok: false,
          reason: "timeout",
          attempts: 2,
          latencyMs: 15001,
        }),
        record,
        logEvent: async () => {
          throw { code: "42501", message: "permission denied PALPITE-SECRETO" };
        },
        build: "b",
      }),
    ).rejects.toThrow(DAILY_EVAL_UNAVAILABLE);
    expect(record).not.toHaveBeenCalled();
    const avisos = JSON.stringify(warn.mock.calls);
    expect(avisos).toContain("falha ao gravar ops_events");
    expect(avisos).toContain("42501");
    expect(avisos).not.toContain("PALPITE-SECRETO");
    warn.mockRestore();
  });

  it("no sucesso, erro ao gravar o evento não impede registrar a tentativa", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await runDailyEvaluation({
      evaluate: async () => ({
        ok: true,
        similarity: 70,
        attempts: 1,
        latencyMs: 900,
      }),
      record: async (s) => ({ similarity: s }),
      logEvent: async () => {
        throw new Error("banco fora");
      },
      build: "b",
    });
    expect(out).toEqual({ similarity: 70 });
    warn.mockRestore();
  });

  it("erro do RPC ao registrar chega ao jogador; o sucesso da IA ainda vira evento", async () => {
    const logEvent = vi.fn(async () => {});
    await expect(
      runDailyEvaluation({
        evaluate: async () => ({
          ok: true,
          similarity: 70,
          attempts: 1,
          latencyMs: 900,
        }),
        record: async () => {
          throw new Error("Não foi possível registrar sua tentativa.");
        },
        logEvent,
        build: "b",
      }),
    ).rejects.toThrow("Não foi possível registrar");
    expect(logEvent).toHaveBeenCalledTimes(1);
  });
});
