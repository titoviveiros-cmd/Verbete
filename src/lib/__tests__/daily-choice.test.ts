// D1 — modo escolha: fórmula D-c, saneamento da resposta, telemetria,
// entrada estrita e a trava do modo juiz. Sem rede, sem banco, sem IA.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHOICE_HOUR_CHANGED,
  CHOICE_MODE_CHANGED,
  CHOICE_NO_SESSION,
  CHOICE_PAUSED,
  CHOICE_UNAVAILABLE,
  DAILY_NOW_CHOICE,
  choiceEvent,
  choicePoints,
  formatOption,
  parseDailyMode,
  runChoiceFinish,
  runChoiceStart,
  sanitizeChoiceFinish,
  sanitizeChoiceStart,
  type ChoiceEvent,
} from "../daily-choice";
import { choiceInput, submitInput } from "../daily-input";
import { DAILY_AI_PAUSED, runGuardedDailyAttempt } from "../daily-guard";
import { DAILY_EVAL_UNAVAILABLE } from "../daily-evaluation";
import { loadDailyMode } from "../daily-mode.server";

const OPTIONS = [
  { pos: 0, text: "Pequena embarcação a remo" },
  { pos: 1, text: "Que tem cor de cobre" },
  { pos: 2, text: "Planta rasteira do litoral" },
  { pos: 3, text: "Dança popular do interior" },
];

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("nenhuma requisição de rede é permitida no modo escolha");
  });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // critério 1: 0 chamadas a provedores
  fetchSpy.mockRestore();
});

describe("critério 17 — D-c: acerto = max(round(max(100 − t, 20) × 0,5), 10)", () => {
  it.each([
    [0, 50],
    [1, 50], // 49,5 → 50 (meio arredonda para cima, igual ao ROUND do Postgres para positivos)
    [2, 49],
    [20, 40],
    [50, 25],
    [60, 20],
    [79, 11], // 10,5 → 11
    [80, 10],
    [81, 10],
    [599, 10],
    [600, 10],
    [9999, 10], // limitado a 600
    [-5, 50], // tempo negativo é tratado como 0
    [12.9, 44], // segundos inteiros (piso): 12 → 44
  ])("t = %s s → %s pontos", (t, pts) => {
    expect(choicePoints(t)).toBe(pts);
  });
  it("faixa total: 10 a 50, nunca fora", () => {
    for (let t = 0; t <= 700; t++) {
      const p = choicePoints(t);
      expect(p).toBeGreaterThanOrEqual(10);
      expect(p).toBeLessThanOrEqual(50);
    }
    expect(choicePoints(Number.NaN)).toBe(10);
  });
});

describe("critério 4 — o início não entrega a correta, ids nem hash", () => {
  it("só os campos listados saem, mesmo se o banco devolver a mais", () => {
    const raw = {
      status: "ok",
      word: "acará",
      category: "fauna",
      elapsed_s: 3,
      hour: "2026-11-08T16:00:00+00:00",
      correct_pos: 2,
      word_id: "11111111-1111-4111-8111-111111111111",
      session_id: "22222222-2222-4222-8222-222222222222",
      hash: "abc",
      options: OPTIONS.map((o, i) => ({
        ...o,
        correct: i === 2,
        id: `id-${i}`,
        word_id: "x",
      })),
    };
    const v = sanitizeChoiceStart(raw);
    expect(v).toEqual({
      status: "ok",
      word: "acará",
      category: "fauna",
      options: OPTIONS,
      elapsedS: 3,
      hour: "2026-11-08T16:00:00.000Z",
    });
    const json = JSON.stringify(v);
    for (const proibido of [
      "correct",
      "word_id",
      "session",
      "hash",
      '"id"',
      "is_correct",
      "truth",
    ])
      expect(json).not.toContain(proibido);
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
  it("alternativas fora do formato (≠ 4, posições erradas, texto vazio) = erro, sem tela quebrada", () => {
    expect(() =>
      sanitizeChoiceStart({
        status: "ok",
        word: "x",
        options: OPTIONS.slice(0, 3),
      }),
    ).toThrow(CHOICE_UNAVAILABLE);
    expect(() =>
      sanitizeChoiceStart({
        status: "ok",
        word: "x",
        options: [...OPTIONS.slice(0, 3), { pos: 7, text: "y" }],
      }),
    ).toThrow(CHOICE_UNAVAILABLE);
    expect(() =>
      sanitizeChoiceStart({
        status: "ok",
        word: "x",
        options: [...OPTIONS.slice(0, 3), { pos: 3, text: " " }],
      }),
    ).toThrow(CHOICE_UNAVAILABLE);
  });
  it("estados sem alternativas: já jogou, outro modo, sem estoque (pausa, nada gasto)", () => {
    expect(sanitizeChoiceStart({ status: "already_played" })).toEqual({
      status: "already_played",
    });
    expect(sanitizeChoiceStart({ status: "mode", mode: "juiz" })).toEqual({
      status: "mode",
      mode: "juiz",
    });
    expect(sanitizeChoiceStart({ status: "mode", mode: "pausa" })).toEqual({
      status: "mode",
      mode: "pausa",
    });
    expect(() => sanitizeChoiceStart({ status: "sem_estoque" })).toThrow(
      CHOICE_PAUSED,
    );
    expect(() => sanitizeChoiceStart(null)).toThrow(CHOICE_UNAVAILABLE);
  });
});

describe("critério 8 — o tempo vem do servidor; o do cliente é REJEITADO", () => {
  it("choiceInput aceita só {pos}", () => {
    expect(
      choiceInput.parse({ pos: 2, hour: "2026-11-08T16:00:00.000Z" }),
    ).toEqual({ pos: 2, hour: "2026-11-08T16:00:00.000Z" });
    expect(() => choiceInput.parse({ pos: 2 })).toThrow(); // sem a hora das alternativas vistas
    expect(() => choiceInput.parse({ pos: 2, hour: "ontem" })).toThrow();
    expect(() => choiceInput.parse({ pos: 2, timeSeconds: 1 })).toThrow();
    expect(() => choiceInput.parse({ pos: 2, time_seconds: 1 })).toThrow();
    expect(() => choiceInput.parse({ pos: 2, user_id: "x" })).toThrow();
    expect(() => choiceInput.parse({ pos: 4 })).toThrow();
    expect(() => choiceInput.parse({ pos: -1 })).toThrow();
    expect(() => choiceInput.parse({ pos: 1.5 })).toThrow();
    expect(() => choiceInput.parse({})).toThrow();
  });
  it("o resultado usa o tempo devolvido pelo servidor", () => {
    const r = sanitizeChoiceFinish({
      status: "recorded",
      result: {
        is_correct: true,
        score: 45,
        time_seconds: 10,
        truth: "t",
        chosen: "t",
        correct_pos: 1,
        chosen_pos: 1,
        current_streak: 2,
        unlocked: ["first_daily"],
      },
    });
    expect(r).toMatchObject({
      already_played: false,
      is_correct: true,
      score: 45,
      time_seconds: 10,
      unlocked: ["first_daily"],
    });
  });
  it("o modo juiz (texto) segue com o próprio schema, sem mudança", () => {
    expect(submitInput.parse({ guess: "x", timeSeconds: 3 })).toEqual({
      guess: "x",
      timeSeconds: 3,
    });
  });
});

describe("critérios 7/9 — recusas do fim não gastam a tentativa e explicam", () => {
  it.each([
    ["mode_changed", CHOICE_MODE_CHANGED],
    ["no_session", CHOICE_NO_SESSION],
    ["hour_changed", CHOICE_HOUR_CHANGED],
    ["qualquer", CHOICE_UNAVAILABLE],
  ])("%s → mensagem certa", (status, msg) => {
    expect(() => sanitizeChoiceFinish({ status })).toThrow(msg);
  });
  it("já jogou (2º envio) → already_played, sem resultado novo", () => {
    expect(sanitizeChoiceFinish({ status: "already_played" })).toEqual({
      already_played: true,
    });
  });
  it("mensagens não falam em IA, juiz, nota ou semelhança", () => {
    for (const m of [
      CHOICE_MODE_CHANGED,
      CHOICE_NO_SESSION,
      CHOICE_HOUR_CHANGED,
      CHOICE_UNAVAILABLE,
      CHOICE_PAUSED,
      DAILY_NOW_CHOICE,
    ])
      expect(m).not.toMatch(/\bIA\b|juiz|nota|semelhan|%/i);
  });
});

describe("critério 22 — telemetria daily_choice_*: modo, resultado e latência; nada pessoal", () => {
  it("evento com lista FECHADA de campos", () => {
    const ev = choiceEvent("finish", "correct", 123.4, "b1");
    expect(ev).toEqual({
      kind: "daily_choice_finish",
      build: "b1",
      payload: { mode: "escolha", result: "correct", latency_ms: 123 },
    });
    expect(Object.keys(ev.payload).sort()).toEqual([
      "latency_ms",
      "mode",
      "result",
    ]);
    expect(
      choiceEvent("start", "palavra-secreta", 1, undefined).payload.result,
    ).toBe("error");
  });
  it("orquestração registra start/finish sem palavra, alternativas, escolha ou jogador", async () => {
    const evs: ChoiceEvent[] = [];
    let t = 1000;
    const now = () => (t += 7);
    const raw = {
      status: "ok",
      word: "acará",
      category: null,
      options: OPTIONS,
      elapsed_s: 0,
      hour: "2026-11-08T16:00:00+00:00",
    };
    await runChoiceStart({
      start: async () => raw,
      logEvent: async (e) => void evs.push(e),
      build: "b",
      now,
    });
    await runChoiceFinish({
      finish: async () => ({
        status: "recorded",
        result: {
          is_correct: false,
          score: 0,
          truth: OPTIONS[1]!.text,
          chosen: OPTIONS[0]!.text,
        },
      }),
      logEvent: async (e) => void evs.push(e),
      build: "b",
      now,
    });
    expect(evs.map((e) => [e.kind, e.payload.result])).toEqual([
      ["daily_choice_start", "ok"],
      ["daily_choice_finish", "wrong"],
    ]);
    const json = JSON.stringify(evs);
    for (const s of ["acará", ...OPTIONS.map((o) => o.text), "user", "hour"])
      expect(json).not.toContain(s);
  });
  it("telemetria que falha não derruba a resposta; banco fora = erro claro e evento 'error'", async () => {
    const r = await runChoiceStart({
      start: async () => ({ status: "already_played" }),
      logEvent: async () => {
        throw new Error("ops_events fora");
      },
      build: null,
    });
    expect(r).toEqual({ status: "already_played" });
    const evs: ChoiceEvent[] = [];
    await expect(
      runChoiceFinish({
        finish: async () => {
          throw new Error("banco fora");
        },
        logEvent: async (e) => void evs.push(e),
        build: null,
      }),
    ).rejects.toThrow(CHOICE_UNAVAILABLE);
    expect(evs[0]!.payload.result).toBe("error");
  });
});

describe("D-a — modo do Diário: inválido nunca liga a escolha; FIXO, independente de ai_mode", () => {
  it("parseDailyMode", () => {
    expect(parseDailyMode("escolha")).toBe("escolha");
    expect(parseDailyMode("pausa")).toBe("pausa");
    for (const v of ["juiz", "auto", "", null, undefined, 1, "ESCOLHA"])
      expect(parseDailyMode(v)).toBe("juiz");
  });
  it("Red Team A5 — loadDailyMode: só a função AUSENTE vira juiz; outro erro lança", async () => {
    expect(
      await loadDailyMode({
        rpc: async () => ({ data: "escolha", error: null }),
      }),
    ).toBe("escolha");
    expect(
      await loadDailyMode({
        rpc: async () => ({ data: null, error: { code: "PGRST202" } }),
      }),
    ).toBe("juiz");
    expect(
      await loadDailyMode({
        rpc: async () => ({ data: null, error: { code: "42883" } }),
      }),
    ).toBe("juiz");
    await expect(
      loadDailyMode({
        rpc: async () => ({ data: null, error: { code: "57014" } }),
      }),
    ).rejects.toThrow("daily_mode 57014");
    await expect(
      loadDailyMode({
        rpc: () => {
          throw new Error("rede");
        },
      }),
    ).rejects.toThrow("rede");
  });

  const juizDeps = () => ({
    claim: vi.fn(async () => ({ status: "bypass" as const })),
    evaluate: vi.fn(async () => ({
      ok: true as const,
      similarity: 90,
      attempts: 1,
      latencyMs: 1,
    })),
    finishOk: vi.fn(),
    finishFail: vi.fn(),
    legacyRecord: vi.fn(async () => ({ already_played: false })),
    logEvent: vi.fn(async () => {}),
    build: "b",
  });
  it("critério 9 (juiz → escolha): envio do modo juiz com o Diário em escolha = recusa SEM reserva, SEM IA, SEM gasto", async () => {
    const d = juizDeps();
    await expect(
      runGuardedDailyAttempt({
        ...d,
        dailyMode: async () => "escolha",
        aiMode: async () => "ligado",
      }),
    ).rejects.toThrow(DAILY_NOW_CHOICE);
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.evaluate).not.toHaveBeenCalled();
    expect(d.legacyRecord).not.toHaveBeenCalled();
  });
  it("pausa = mensagem de pausa, nada reservado", async () => {
    const d = juizDeps();
    await expect(
      runGuardedDailyAttempt({ ...d, dailyMode: async () => "pausa" }),
    ).rejects.toThrow(DAILY_AI_PAUSED);
    expect(d.claim).not.toHaveBeenCalled();
  });
  it("critério 21: 'juiz' (ou sem a dependência) = fluxo atual intacto", async () => {
    for (const dailyMode of [async () => "juiz" as const, undefined]) {
      const d = juizDeps();
      await runGuardedDailyAttempt({
        ...d,
        ...(dailyMode ? { dailyMode } : {}),
      });
      expect(d.claim).toHaveBeenCalledTimes(1);
      expect(d.evaluate).toHaveBeenCalledTimes(1);
      expect(d.legacyRecord).toHaveBeenCalledWith(90);
    }
  });
  it("Red Team A5: erro ao ler o modo = recusa SEM reserva, SEM IA, SEM gasto (fail-closed)", async () => {
    const d = juizDeps();
    await expect(
      runGuardedDailyAttempt({
        ...d,
        dailyMode: async () => Promise.reject(new Error("x")),
      }),
    ).rejects.toThrow(DAILY_EVAL_UNAVAILABLE);
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.evaluate).not.toHaveBeenCalled();
    expect(d.legacyRecord).not.toHaveBeenCalled();
  });
  it("D-a: escolha é FIXA — ai_mode 'ligado' não reabre o juiz", async () => {
    const d = juizDeps();
    await expect(
      runGuardedDailyAttempt({
        ...d,
        dailyMode: async () => "escolha",
        aiMode: async () => "ligado",
      }),
    ).rejects.toThrow(DAILY_NOW_CHOICE);
  });
});

describe("forma uniforme das alternativas (espelho do SQL daily_choice_fmt)", () => {
  it("maiúscula inicial e sem pontuação no fim", () => {
    expect(formatOption("  espinho; recife à flor da água. ")).toBe(
      "Espinho; recife à flor da água",
    );
    expect(formatOption("ébano;")).toBe("Ébano");
    expect(formatOption("Já formatada")).toBe("Já formatada");
    expect(formatOption(" .")).toBe("");
  });
});
