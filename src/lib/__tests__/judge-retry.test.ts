// Orçamento de novas tentativas do juiz do bônus 🧠 (auditoria operacional de
// 2026-10-24). Casos de produção de 18–24/10: 503 rápido em sequência (a edge
// desistia em ~1,8 s com ~15 s de prazo sobrando), timeout de 8 s seguido de
// 503 (sala 3532, 24/10 13:02), dois timeouts (17 s, 22/10 de manhã) e 429 em
// rajada (cota/ritmo, 22/10 à noite). Relógio falso: os prazos são os REAIS.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JUDGE_BUDGET,
  judgeCandidates,
} from "../../../supabase/functions/_shared/semantic.ts";

type Step = "503" | "429" | "timeout" | { score: number; afterMs: number };

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
  });

/** Gemini simulado: cada chamada consome o próximo passo do roteiro. */
const scripted = (steps: Step[]) =>
  vi.fn((_u: string, init: RequestInit) => {
    const step = steps.shift() ?? "503";
    if (step === "timeout") {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }
    if (step === "503" || step === "429") {
      return Promise.resolve(new Response("x", { status: Number(step) }));
    }
    return new Promise<Response>((resolve) =>
      setTimeout(
        () =>
          resolve(
            ok(JSON.stringify({ scores: [{ id: "a", score: step.score }] })),
          ),
        step.afterMs,
      ),
    );
  });

/** O juiz como a edge score-similarity o chama, com o relógio falso. */
const judge = async (steps: Step[], budget: object = JUDGE_BUDGET) => {
  const fetchFn = scripted(steps);
  const t0 = Date.now();
  const p = judgeCandidates({
    fetchFn,
    apiKey: "k",
    word: "hiena",
    truth: "mamífero carnívoro das savanas",
    candidates: [{ id: "a", text: "animal carnívoro que vive nas savanas" }],
    ...budget,
  });
  await vi.runAllTimersAsync();
  const r = await p;
  return { r, calls: fetchFn.mock.calls.length, elapsed: Date.now() - t0 };
};

// O pg_net corta a chamada da edge em 20 s (fire_round_judge); a edge ainda
// lê e grava o banco antes e depois da IA.
const PG_NET_TIMEOUT_MS = 20_000;
const DB_SLACK_MS = 2_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("juiz do 🧠: novas tentativas dentro do prazo do pg_net", () => {
  it("503, 503 e a nota: aprova na 3ª tentativa, no MESMO disparo (sem esperar o cron)", async () => {
    const { r, calls, elapsed } = await judge([
      "503",
      "503",
      { score: 90, afterMs: 1_500 },
    ]);
    expect(r).toMatchObject({ ok: true, matches: ["a"], attempts: 3 });
    expect(calls).toBe(3);
    expect(elapsed).toBeLessThan(PG_NET_TIMEOUT_MS - DB_SLACK_MS);
  });

  it("timeout de 8 s e 503: a 3ª tentativa usa o que sobra do prazo e aprova", async () => {
    const { r, calls, elapsed } = await judge([
      "timeout",
      "503",
      { score: 85, afterMs: 3_000 },
    ]);
    expect(r).toMatchObject({ ok: true, matches: ["a"], attempts: 3 });
    expect(calls).toBe(3);
    expect(elapsed).toBeLessThan(PG_NET_TIMEOUT_MS - DB_SLACK_MS);
  });

  it("dois timeouts esgotam o prazo: desiste na 2ª, antes de o pg_net cortar", async () => {
    const { r, calls, elapsed } = await judge([
      "timeout",
      "timeout",
      "timeout",
      "timeout",
    ]);
    expect(r).toMatchObject({ ok: false, reason: "timeout", attempts: 2 });
    expect(calls).toBe(2);
    expect(elapsed).toBeLessThanOrEqual(PG_NET_TIMEOUT_MS - DB_SLACK_MS);
  });

  it("503 o tempo todo: nunca passa do prazo, por mais tentativas que sobrem", async () => {
    const { r, elapsed } = await judge(Array(10).fill("503") as Step[]);
    expect(r).toMatchObject({ ok: false, reason: "http_error", status: 503 });
    expect(elapsed).toBeLessThanOrEqual(PG_NET_TIMEOUT_MS - DB_SLACK_MS);
  });

  it("429 em rajada: não insiste além da 2ª (o limite é por minuto; quem espera é o reenvio do banco)", async () => {
    const { r, calls } = await judge(["429", "429", "429", "429"]);
    expect(r).toMatchObject({
      ok: false,
      reason: "http_error",
      status: 429,
      attempts: 2,
    });
    expect(calls).toBe(2);
  });

  it("gate dos bots (timeoutMs/retries explícitos, sem prazo total) segue com 1 tentativa só", async () => {
    const { r, calls } = await judge(["503", { score: 90, afterMs: 100 }], {
      timeoutMs: 3_500,
      retries: 0,
    });
    expect(r).toMatchObject({ ok: false, status: 503, attempts: 1 });
    expect(calls).toBe(1);
  });
});
