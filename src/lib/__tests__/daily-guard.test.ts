// V2 — Desafio Diário: orquestração da reserva ANTES da IA (sem rede nem banco).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_EVAL_UNAVAILABLE,
  evaluateDailyGuess,
  type DailyEvalResult,
} from "../daily-evaluation";
import {
  DAILY_HOUR_CHANGED,
  DAILY_IN_PROGRESS,
  DAILY_RATE_LIMITED,
  DAILY_RECORD_FAILED,
  DAILY_STALE,
  DAILY_PREP_TIMEOUT_MS,
  runGuardedDailyAttempt,
  withTimeout,
  type ClaimResponse,
  type FinishOkResponse,
} from "../daily-guard";
import { submitInput } from "../daily-input";
import { DAILY_ID } from "../../../supabase/functions/_shared/semantic.ts";

const RESULT = {
  already_played: false,
  is_correct: true,
  score: 82,
  similarity: 90,
  current_streak: 3,
  unlocked: [],
};
const ATTEMPT = { guess: "x", is_correct: true, score: 80 };

function deps(
  over: {
    claim?: ClaimResponse | (() => Promise<ClaimResponse>);
    evaluate?: () => Promise<DailyEvalResult>;
    finishOk?: () => Promise<FinishOkResponse>;
  } = {},
) {
  const claimFn =
    typeof over.claim === "function"
      ? over.claim
      : async () =>
          (over.claim as ClaimResponse) ?? {
            status: "claimed",
            claim_id: "c-1",
            mode: "aplicar",
          };
  const d = {
    claim: vi.fn(claimFn),
    evaluate: vi.fn(
      over.evaluate ??
        (async (): Promise<DailyEvalResult> => ({
          ok: true,
          similarity: 90,
          attempts: 1,
          latencyMs: 5,
        })),
    ),
    finishOk: vi.fn(
      over.finishOk ??
        (async (): Promise<FinishOkResponse> => ({
          status: "recorded",
          result: RESULT,
        })),
    ),
    finishFail: vi.fn(async () => ({ status: "released" })),
    legacyRecord: vi.fn(async (sim: number) => ({
      ...RESULT,
      similarity: sim,
    })),
    logEvent: vi.fn(async () => {}),
    build: "build-teste",
  };
  return d;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("V2 Diário: reserva antes da IA", () => {
  it("1. primeira tentativa legítima: 1 reserva, 1 IA, grava pelo claim e devolve o resultado INALTERADO", async () => {
    const d = deps();
    await expect(runGuardedDailyAttempt(d)).resolves.toEqual(RESULT);
    expect(d.claim).toHaveBeenCalledTimes(1);
    expect(d.evaluate).toHaveBeenCalledTimes(1);
    expect(d.finishOk).toHaveBeenCalledWith("c-1", 90);
    expect(d.finishFail).not.toHaveBeenCalled();
    expect(d.legacyRecord).not.toHaveBeenCalled();
  });

  it("2. já jogou (aplicar): NENHUMA IA e resposta no formato atual ({already_played, attempt})", async () => {
    const d = deps({
      claim: {
        status: "already_played",
        mode: "aplicar",
        already_played: true,
        attempt: ATTEMPT,
      },
    });
    await expect(runGuardedDailyAttempt(d)).resolves.toEqual({
      already_played: true,
      attempt: ATTEMPT,
    });
    expect(d.evaluate).not.toHaveBeenCalled();
    expect(d.finishOk).not.toHaveBeenCalled();
  });

  it.each([
    ["in_progress", DAILY_IN_PROGRESS],
    ["rate_limited", DAILY_RATE_LIMITED],
    ["cooldown", DAILY_EVAL_UNAVAILABLE],
    ["provider_unavailable", DAILY_EVAL_UNAVAILABLE],
  ] as const)(
    "3/14. recusa '%s': mensagem certa e NENHUMA chamada à IA nem gravação",
    async (status, msg) => {
      const d = deps({ claim: { status, mode: "aplicar" } });
      await expect(runGuardedDailyAttempt(d)).rejects.toThrow(msg);
      expect(d.evaluate).not.toHaveBeenCalled();
      expect(d.finishOk).not.toHaveBeenCalled();
      expect(d.finishFail).not.toHaveBeenCalled();
      expect(d.legacyRecord).not.toHaveBeenCalled();
    },
  );

  it("3. duplo clique: o 2º envio recebe 'em andamento' sem IA (a reserva atômica é do banco)", async () => {
    let n = 0;
    const d = deps({
      claim: async () =>
        ++n === 1
          ? { status: "claimed", claim_id: "c-1", mode: "aplicar" }
          : { status: "in_progress", mode: "aplicar" },
    });
    const [a, b] = await Promise.allSettled([
      runGuardedDailyAttempt(d),
      runGuardedDailyAttempt(d),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason.message).toBe(DAILY_IN_PROGRESS);
    expect(d.evaluate).toHaveBeenCalledTimes(1);
  });

  it("6a. banco FORA na reserva: NENHUMA IA, tentativa não gasta (fail-closed)", async () => {
    const d = deps({
      claim: async () => {
        throw new Error("daily_claim 08006");
      },
    });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
      DAILY_EVAL_UNAVAILABLE,
    );
    expect(d.evaluate).not.toHaveBeenCalled();
  });

  it("6a'. resposta de reserva inválida: NENHUMA IA", async () => {
    for (const ruim of [
      null,
      {},
      { status: "qualquer" },
    ] as unknown as ClaimResponse[]) {
      const d = deps({ claim: async () => ruim });
      await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
        DAILY_EVAL_UNAVAILABLE,
      );
      expect(d.evaluate).not.toHaveBeenCalled();
    }
  });

  it("6b. banco FORA ao gravar (depois da IA): libera como falha NOSSA, sem 2ª IA, tentativa não gasta", async () => {
    const d = deps({
      finishOk: async () => {
        throw new Error("daily_finish_ok 08006");
      },
    });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
      DAILY_RECORD_FAILED,
    );
    expect(d.evaluate).toHaveBeenCalledTimes(1);
    expect(d.finishFail).toHaveBeenCalledWith("c-1", "persist");
  });

  it("7. reserva vencida / resposta atrasada: 'stale' não grava e não chama a IA de novo", async () => {
    const d = deps({ finishOk: async () => ({ status: "stale" }) });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(DAILY_STALE);
    expect(d.evaluate).toHaveBeenCalledTimes(1);
  });

  it("8. virada da hora durante a avaliação: 'hour_changed', tentativa não gasta", async () => {
    const d = deps({ finishOk: async () => ({ status: "hour_changed" }) });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(DAILY_HOUR_CHANGED);
    expect(d.evaluate).toHaveBeenCalledTimes(1);
  });

  it("finalização com status desconhecido: erro seguro, sem 2ª IA", async () => {
    const d = deps({
      finishOk: async () => ({ status: "x" }) as unknown as FinishOkResponse,
    });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
      DAILY_RECORD_FAILED,
    );
    expect(d.evaluate).toHaveBeenCalledTimes(1);
  });
});

describe("V2 Diário: falhas da IA (provedor) não gastam a tentativa", () => {
  const ok = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
    });
  const real =
    (fetchFn: (u: string, i: RequestInit) => Promise<Response>) => () =>
      evaluateDailyGuess({
        fetchFn,
        apiKey: "k",
        word: "w",
        truth: "t",
        guess: "g",
      });

  it("5a. HTTP 503 persistente: libera como falha do PROVEDOR, sem gravar", async () => {
    const d = deps({
      evaluate: real(async () => new Response("x", { status: 503 })),
    });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
      DAILY_EVAL_UNAVAILABLE,
    );
    expect(d.finishFail).toHaveBeenCalledWith("c-1", "provider");
    expect(d.finishOk).not.toHaveBeenCalled();
    expect(d.logEvent).toHaveBeenCalledTimes(1);
  });

  it("5b. JSON inválido da IA: 'invalid' (conta no jogador, NÃO no disjuntor global), sem gravar", async () => {
    const d = deps({ evaluate: real(async () => ok("isto não é json")) });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
      DAILY_EVAL_UNAVAILABLE,
    );
    expect(d.finishFail).toHaveBeenCalledWith("c-1", "invalid");
    expect(d.finishOk).not.toHaveBeenCalled();
  });

  it("5c. timeout: falha do PROVEDOR, sem gravar", async () => {
    const d = deps({
      evaluate: async () => ({
        ok: false,
        reason: "timeout",
        attempts: 2,
        latencyMs: 15000,
      }),
    });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
      DAILY_EVAL_UNAVAILABLE,
    );
    expect(d.finishFail).toHaveBeenCalledWith("c-1", "provider");
  });

  it("5d. a IA lançar exceção inesperada conta como falha do provedor", async () => {
    const d = deps({
      evaluate: async () => {
        throw new Error("boom");
      },
    });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
      DAILY_EVAL_UNAVAILABLE,
    );
    expect(d.finishFail).toHaveBeenCalledWith("c-1", "provider");
  });

  it("9. sem chave ou sem definição: falha NOSSA ('persist'), não pune o jogador nem abre o disjuntor", async () => {
    const d = deps({
      evaluate: async () => ({
        ok: false,
        reason: "missing_truth",
        attempts: 0,
        latencyMs: 0,
      }),
    });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
      DAILY_EVAL_UNAVAILABLE,
    );
    expect(d.finishFail).toHaveBeenCalledWith("c-1", "persist");
  });

  it("5e. sucesso depois de uma falha: a nova reserva grava normalmente", async () => {
    const d = deps({
      evaluate: real(
        vi
          .fn()
          .mockResolvedValueOnce(new Response("x", { status: 503 }))
          .mockResolvedValue(
            ok(JSON.stringify({ scores: [{ id: DAILY_ID, score: 88 }] })),
          ),
      ),
    });
    await expect(runGuardedDailyAttempt(d)).resolves.toEqual(RESULT);
    expect(d.finishOk).toHaveBeenCalledWith("c-1", 88);
  });
});

describe("V2 Diário: modos desligado/observar = fluxo antigo", () => {
  it.each(["bypass", "pass_no_claim"] as const)(
    "11. '%s': fluxo antigo idêntico (IA + submit_daily_attempt_scored), sem finish",
    async (status) => {
      const d = deps({
        claim: { status, mode: status === "bypass" ? "desligado" : "observar" },
      });
      await expect(runGuardedDailyAttempt(d)).resolves.toEqual({
        ...RESULT,
        similarity: 90,
      });
      expect(d.evaluate).toHaveBeenCalledTimes(1);
      expect(d.legacyRecord).toHaveBeenCalledWith(90);
      expect(d.finishOk).not.toHaveBeenCalled();
      expect(d.finishFail).not.toHaveBeenCalled();
    },
  );

  it("11. fluxo antigo com falha da IA: igual a antes (evento + aviso, tentativa não gasta)", async () => {
    const d = deps({
      claim: { status: "bypass", mode: "desligado" },
      evaluate: async () => ({
        ok: false,
        reason: "http_error",
        status: 503,
        attempts: 3,
        latencyMs: 1,
      }),
    });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(
      DAILY_EVAL_UNAVAILABLE,
    );
    expect(d.legacyRecord).not.toHaveBeenCalled();
    expect(d.logEvent).toHaveBeenCalledTimes(1);
  });
});

describe("V2 Diário: identidade e privacidade", () => {
  it("10. identidade forjada pelo cliente é DESCARTADA pelo schema (o usuário vem da sessão)", () => {
    const parsed = submitInput.parse({
      guess: "um palpite",
      timeSeconds: 12,
      user_id: "00000000-0000-0000-0000-000000000000",
      userId: "x",
    });
    expect(parsed).toEqual({ guess: "um palpite", timeSeconds: 12 });
    expect(() => submitInput.parse({ guess: "", timeSeconds: 1 })).toThrow();
    expect(() =>
      submitInput.parse({ guess: "x".repeat(201), timeSeconds: 1 }),
    ).toThrow();
  });

  it("15. nenhum palpite, palavra, definição ou chave em logs/eventos (falha do provedor)", async () => {
    const d = deps({
      evaluate: async () => ({
        ok: false,
        reason: "http_error",
        status: 503,
        attempts: 3,
        latencyMs: 9,
      }),
    });
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow();
    const texto = JSON.stringify([d.logEvent.mock.calls, warn.mock.calls]);
    for (const proibido of [
      "um palpite",
      "palavra-secreta",
      "definição verdadeira",
      "sk-",
      "AIza",
    ])
      expect(texto).not.toContain(proibido);
  });
});

describe("V2 Diário: prazo antes da IA (reserva de 45 s)", () => {
  it("4. leituras lentas do banco viram falha NOSSA sem IA; a soma prazo + IA (15 s) fica bem abaixo da reserva (45 s)", async () => {
    vi.useFakeTimers();
    try {
      const lenta = new Promise<{ word: string; truth: string }>(() => {}); // nunca responde
      const p = withTimeout(lenta, DAILY_PREP_TIMEOUT_MS, {
        word: "",
        truth: "",
      });
      await vi.advanceTimersByTimeAsync(DAILY_PREP_TIMEOUT_MS);
      await expect(p).resolves.toEqual({ word: "", truth: "" });
    } finally {
      vi.useRealTimers();
    }
    expect(DAILY_PREP_TIMEOUT_MS + 15_000).toBeLessThan(45_000 - 15_000); // folga de 15 s ou mais
    const rapida = await withTimeout(
      Promise.resolve({ word: "w", truth: "t" }),
      1000,
      { word: "", truth: "" },
    );
    expect(rapida).toEqual({ word: "w", truth: "t" });
  });
});
