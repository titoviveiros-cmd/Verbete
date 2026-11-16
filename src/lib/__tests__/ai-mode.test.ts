// Contenção da IA (app_config.ai_mode; docs/contencao-ia.md): lógica pura
// compartilhada pelas edges e pelo Worker, e o Diário em pausa.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Estes testes cobrem o adaptador/contenção com a IA externa LIGADA. O corte
// do modo sem IA (EXTERNAL_AI_MODE = "desligada") está em
// src/components/__tests__/legal-sem-ia.test.tsx.
vi.mock("../../../supabase/functions/_shared/external-ai.ts", () => ({
  EXTERNAL_AI_MODE: "ligada",
  isExternalAiOff: (m?: string) => m === "desligada",
}));
import {
  AI_MODE_CACHE_MS,
  AI_SUSPENDED_EVENT_WINDOW_MS,
  aiSuspendedEvent,
  createAiModeReader,
  createSuspendedLogger,
  loadAiModeValue,
  parseAiMode,
  skipJudgeSuspended,
  suspendedEventIO,
} from "../../../supabase/functions/_shared/ai-mode.ts";
import {
  dropAlreadyServed,
  dropMalformed,
  dropMatchRepeats,
  dropNearTruth,
  vetReserves,
} from "../../../supabase/functions/bot-definitions/logic.ts";
import { RESERVE_DEFINITIONS } from "../../../supabase/functions/bot-definitions-v2/reserves.ts";
import { evaluateDailyGuess } from "../daily-evaluation";
import { DAILY_AI_PAUSED, runGuardedDailyAttempt } from "../daily-guard";

describe("parseAiMode: ausente/inválido = ligado", () => {
  it.each([
    undefined,
    null,
    "",
    "ligado",
    "on",
    "off",
    "desligado",
    "SUSP",
    1,
    {},
  ])("%j → ligado", (v) => expect(parseAiMode(v)).toBe("ligado"));
  it.each(["suspenso", " SUSPENSO ", "Suspenso"])("%j → suspenso", (v) =>
    expect(parseAiMode(v)).toBe("suspenso"),
  );
});

describe("createAiModeReader: leitura barata com cache curto", () => {
  it("lê uma vez dentro do TTL e relê depois dele", async () => {
    let t = 0;
    const read = createAiModeReader({ now: () => t });
    const load = vi.fn(async () => "suspenso");
    expect(await read(load)).toBe("suspenso");
    t = AI_MODE_CACHE_MS - 1;
    expect(await read(load)).toBe("suspenso");
    expect(load).toHaveBeenCalledTimes(1);
    t = AI_MODE_CACHE_MS;
    load.mockResolvedValueOnce("ligado");
    expect(await read(load)).toBe("ligado");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("chave ausente (null) = ligado", async () => {
    const read = createAiModeReader();
    expect(await read(async () => null)).toBe("ligado");
  });

  it("erro de leitura sem valor anterior = ligado (falha aberta), nunca lança", async () => {
    const read = createAiModeReader();
    await expect(
      read(async () => {
        throw new Error("db fora");
      }),
    ).resolves.toBe("ligado");
  });

  it("erro de leitura com valor anterior = mantém o último conhecido", async () => {
    let t = 0;
    const read = createAiModeReader({ now: () => t });
    expect(await read(async () => "suspenso")).toBe("suspenso");
    t = AI_MODE_CACHE_MS * 2;
    expect(
      await read(async () => {
        throw new Error("db fora");
      }),
    ).toBe("suspenso");
  });
});

describe("evento ai_suspended: 1 por função na janela, sem dado pessoal", () => {
  const io = (recent = false) => ({
    recent: vi.fn(async () => recent),
    insert: vi.fn(async () => {}),
  });

  it("grava 1 evento e segura os seguintes em memória dentro da janela", async () => {
    let t = 1_000_000;
    const log = createSuspendedLogger({ now: () => t });
    const a = io();
    expect(await log("daily", a)).toBe(true);
    t += 1000;
    expect(await log("daily", a)).toBe(false);
    expect(a.insert).toHaveBeenCalledTimes(1);
    expect(a.recent).toHaveBeenCalledTimes(1);
    // outra função tem a própria janela
    expect(await log("score-similarity", a)).toBe(true);
    t += AI_SUSPENDED_EVENT_WINDOW_MS;
    expect(await log("daily", a)).toBe(true);
    expect(a.insert).toHaveBeenCalledTimes(3);
  });

  it("já há evento no banco na janela (outro isolate) → não grava", async () => {
    const log = createSuspendedLogger();
    const a = io(true);
    expect(await log("daily", a)).toBe(false);
    expect(a.insert).not.toHaveBeenCalled();
  });

  it("consulta falha → grava mesmo assim; gravação falha → não lança", async () => {
    const log = createSuspendedLogger();
    const insert = vi.fn(async () => {});
    expect(
      await log("bot-definitions", {
        recent: async () => {
          throw new Error("x");
        },
        insert,
      }),
    ).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    await expect(
      log("bot-definitions-v2", {
        recent: async () => false,
        insert: async () => {
          throw new Error("x");
        },
      }),
    ).resolves.toBe(false);
  });

  it("payload só com função e modo", () => {
    expect(aiSuspendedEvent("daily")).toEqual({
      kind: "ai_suspended",
      payload: { fn: "daily", mode: "suspenso" },
    });
  });
});

describe("E/S com o supabase-js (service role)", () => {
  const chain = (result: { data: unknown; error: unknown }) => {
    const calls: Array<[string, unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "limit", "maybeSingle", "insert"])
      q[m] = (...args: unknown[]) => {
        calls.push([m, args]);
        return m === "maybeSingle" || m === "limit" || m === "insert"
          ? Promise.resolve(result)
          : q;
      };
    const from = vi.fn(() => q);
    return { db: { from }, calls, from };
  };

  it("lê app_config.ai_mode; erro do banco lança (o leitor decide)", async () => {
    const ok = chain({ data: { value: "suspenso" }, error: null });
    expect(await loadAiModeValue(ok.db)).toBe("suspenso");
    expect(ok.from).toHaveBeenCalledWith("app_config");
    expect(ok.calls).toContainEqual(["eq", ["key", "ai_mode"]]);
    const missing = chain({ data: null, error: null });
    expect(await loadAiModeValue(missing.db)).toBeUndefined();
    const bad = chain({ data: null, error: { code: "42501" } });
    await expect(loadAiModeValue(bad.db)).rejects.toThrow("42501");
  });

  it("throttle no banco filtra por kind, função e janela", async () => {
    const c = chain({ data: [{ id: 1 }], error: null });
    const io = suspendedEventIO(c.db);
    expect(await io.recent("daily", "2026-11-05T00:00:00.000Z")).toBe(true);
    expect(c.calls).toEqual(
      expect.arrayContaining([
        ["eq", ["kind", "ai_suspended"]],
        ["eq", ["payload->>fn", "daily"]],
        ["gte", ["at", "2026-11-05T00:00:00.000Z"]],
      ]),
    );
  });
});

describe("juiz do 🧠 com a IA suspensa", () => {
  it("marca a rodada julgada, sem bônus e SEM 'error' (o cron não reenvia)", async () => {
    const markJudged = vi.fn(async () => {});
    const logSuspended = vi.fn(async () => true);
    const r = await skipJudgeSuspended({ markJudged, logSuspended });
    expect(r).toEqual({ matches: [], skipped: "ai_suspended" });
    expect("error" in r).toBe(false);
    expect(markJudged).toHaveBeenCalledTimes(1);
    expect(logSuspended).toHaveBeenCalledTimes(1);
  });

  it("marca falhou → mesma resposta 200 sem erro (o retry_round_judgments marca pela resposta)", async () => {
    const r = await skipJudgeSuspended({
      markJudged: async () => {
        throw new Error("db");
      },
      logSuspended: async () => {
        throw new Error("db");
      },
    });
    expect(r).toEqual({ matches: [], skipped: "ai_suspended" });
  });
});

describe("bots com a IA suspensa: reservas pelos mesmos filtros de sempre", () => {
  it("vetReserves = a cadeia forma → vazamento → partida → servidas da v2", () => {
    const word = "pindaiba";
    const meaning = "falta de dinheiro; situacao de pobreza";
    const reserves = [
      ...RESERVE_DEFINITIONS.slice(0, 10),
      "falta de dinheiro situacao de pobreza",
      "pindaiba pindaiba",
    ];
    const previous = [RESERVE_DEFINITIONS[0]!];
    const servedNorms = [RESERVE_DEFINITIONS[1]!];
    const a = dropMalformed(reserves, word);
    const b = dropNearTruth(a.kept, meaning);
    const c = dropMatchRepeats(b.kept, previous);
    const d = dropAlreadyServed(c.kept, servedNorms);
    const got = vetReserves(reserves, { word, meaning, previous, servedNorms });
    expect(got).toEqual(d.kept);
    expect(got).not.toContain("falta de dinheiro situacao de pobreza");
    expect(got.length).toBeGreaterThan(0);
  });
});

describe("Desafio Diário com a IA suspensa", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const deps = (mode: "ligado" | "suspenso" | "erro") => {
    const providerFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"scores":[{"id":"palpite","score":90}]}',
                },
              },
            ],
          }),
        ),
    );
    return {
      providerFetch,
      aiMode: vi.fn(async () => {
        if (mode === "erro") throw new Error("db");
        return mode;
      }),
      logSuspended: vi.fn(async () => true),
      claim: vi.fn(async () => ({
        status: "claimed" as const,
        claim_id: "c-1",
      })),
      evaluate: vi.fn(() =>
        evaluateDailyGuess({
          fetchFn: providerFetch,
          apiKey: "k",
          word: "palavra",
          truth: "definicao",
          guess: "palpite",
        }),
      ),
      finishOk: vi.fn(async () => ({
        status: "recorded" as const,
        result: { already_played: false },
      })),
      finishFail: vi.fn(async () => ({})),
      legacyRecord: vi.fn(async () => ({ already_played: false })),
      logEvent: vi.fn(async () => {}),
      build: "b",
    };
  };

  it("suspenso: mensagem de pausa, NENHUMA reserva, IA, fetch do provedor ou gravação", async () => {
    const d = deps("suspenso");
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(DAILY_AI_PAUSED);
    expect(DAILY_AI_PAUSED).toMatch(/em pausa para manutenção/);
    expect(DAILY_AI_PAUSED).toMatch(/NÃO foi gasta/);
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.evaluate).not.toHaveBeenCalled();
    expect(d.providerFetch).not.toHaveBeenCalled();
    expect(d.finishOk).not.toHaveBeenCalled();
    expect(d.finishFail).not.toHaveBeenCalled();
    expect(d.legacyRecord).not.toHaveBeenCalled();
    expect(d.logEvent).not.toHaveBeenCalled(); // não é falha do juiz
    expect(d.logSuspended).toHaveBeenCalledTimes(1);
  });

  it("suspenso com a telemetria falhando: mesma pausa", async () => {
    const d = deps("suspenso");
    d.logSuspended.mockRejectedValueOnce(new Error("db"));
    await expect(runGuardedDailyAttempt(d)).rejects.toThrow(DAILY_AI_PAUSED);
  });

  it.each(["ligado", "erro"] as const)(
    "modo %s: fluxo normal (reserva → IA → gravação)",
    async (mode) => {
      const d = deps(mode);
      await expect(runGuardedDailyAttempt(d)).resolves.toEqual({
        already_played: false,
      });
      expect(d.claim).toHaveBeenCalledTimes(1);
      expect(d.providerFetch).toHaveBeenCalledTimes(1);
      expect(d.logSuspended).not.toHaveBeenCalled();
    },
  );

  it("sem a dependência aiMode (chamador antigo): fluxo normal", async () => {
    const { aiMode: _a, logSuspended: _l, ...d } = deps("suspenso");
    await expect(runGuardedDailyAttempt(d)).resolves.toEqual({
      already_played: false,
    });
  });
});

// ---- Corte sem banco (06/11/2026): AI_FORCE_SUSPEND e chave do provedor ausente ----
import { readFileSync } from "node:fs";
import {
  AI_FORCE_SUSPEND_ENV,
  AI_PROVIDER_KEY_ENV,
  forcedSuspensionFrom,
  isForcedSuspension,
} from "../../../supabase/functions/_shared/ai-mode.ts";

describe("corte FECHADO pelo ambiente (não depende do Supabase)", () => {
  const env = (o: Record<string, string | undefined>) => (k: string) => o[k];
  const COM_CHAVE = { [AI_PROVIDER_KEY_ENV]: "k" };

  it.each(["1", "true", "SIM", " suspenso "])(
    "AI_FORCE_SUSPEND=%j suspende",
    (v) => expect(isForcedSuspension(v)).toBe(true),
  );
  it.each([undefined, "", "0", "false", "ligado", "não"])(
    "AI_FORCE_SUSPEND=%j não suspende",
    (v) => expect(isForcedSuspension(v)).toBe(false),
  );

  it("chave do provedor ausente/vazia = suspenso; presente e sem flag = segue o banco", () => {
    expect(forcedSuspensionFrom(env({}))).toBe(true);
    expect(forcedSuspensionFrom(env({ [AI_PROVIDER_KEY_ENV]: "  " }))).toBe(
      true,
    );
    expect(forcedSuspensionFrom(env(COM_CHAVE))).toBe(false);
    expect(
      forcedSuspensionFrom(env({ ...COM_CHAVE, [AI_FORCE_SUSPEND_ENV]: "1" })),
    ).toBe(true);
  });

  it("Supabase FORA num isolate novo: sem flag = ligado (falha aberta do banco); com flag = suspenso sem ler o banco", async () => {
    const dbFora = vi.fn(async () => {
      throw new Error("supabase fora");
    });
    expect(
      await createAiModeReader({
        forced: () => forcedSuspensionFrom(env(COM_CHAVE)),
      })(dbFora),
    ).toBe("ligado");
    const forcado = createAiModeReader({
      forced: () =>
        forcedSuspensionFrom(
          env({ ...COM_CHAVE, [AI_FORCE_SUSPEND_ENV]: "1" }),
        ),
    });
    dbFora.mockClear();
    expect(await forcado(dbFora)).toBe("suspenso");
    expect(dbFora).not.toHaveBeenCalled();
  });

  it("a flag vence o cache 'ligado' na hora (sem esperar o TTL)", async () => {
    let flag = false;
    const read = createAiModeReader({ now: () => 0, forced: () => flag });
    const load = vi.fn(async () => "ligado");
    expect(await read(load)).toBe("ligado");
    flag = true;
    expect(await read(load)).toBe("suspenso");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ambiente ilegível (forced lança) = segue para o banco", async () => {
    const read = createAiModeReader({
      forced: () => {
        throw new Error("env");
      },
    });
    expect(await read(async () => "suspenso")).toBe("suspenso");
  });

  it("troca de modo com chamada em andamento: quem já leu 'ligado' conclui; as próximas leem 'suspenso' após o TTL", async () => {
    let t = 0;
    let valor = "ligado";
    const read = createAiModeReader({ now: () => t });
    const load = async () => valor;
    expect(await read(load)).toBe("ligado"); // pedido A já liberado
    valor = "suspenso"; // UPDATE no banco
    t = AI_MODE_CACHE_MS - 1;
    expect(await read(load)).toBe("ligado"); // mesmo isolate, dentro do cache
    t = AI_MODE_CACHE_MS;
    expect(await read(load)).toBe("suspenso");
  });

  it("Diário: chave removida = pausa, sem reserva nem chamada ao provedor", async () => {
    const read = createAiModeReader({
      forced: () => forcedSuspensionFrom(env({})),
    });
    const claim = vi.fn();
    const evaluate = vi.fn();
    await expect(
      runGuardedDailyAttempt({
        aiMode: () => read(async () => "ligado"),
        logSuspended: async () => true,
        claim,
        evaluate,
        finishOk: vi.fn(),
        finishFail: vi.fn(),
        legacyRecord: vi.fn(),
        logEvent: vi.fn(),
        build: "b",
      } as never),
    ).rejects.toThrow(DAILY_AI_PAUSED);
    expect(claim).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    "supabase/functions/score-similarity/index.ts",
    "supabase/functions/bot-definitions/index.ts",
    "supabase/functions/bot-definitions-v2/index.ts",
    "src/lib/daily.functions.ts",
  ])("%s liga o leitor ao corte do ambiente", (f) => {
    const src = readFileSync(f, "utf8");
    expect(src).toMatch(
      /createAiModeReader\(\{\s*\/\/[^\n]*\n\s*forced: \(\) => forcedSuspensionFrom\(/,
    );
    // o modo é lido ANTES de qualquer uso da chave do provedor — que só é
    // lida pelo adaptador (resolveAiProvider, docs/provedor-ia.md)
    const iModo = src.indexOf("readAiMode(");
    const iChave = src.indexOf("resolveAiProvider(");
    expect(iModo).toBeGreaterThan(0);
    expect(iChave).toBeGreaterThan(iModo);
    expect(src).not.toMatch(
      new RegExp(
        `env\\.get\\("${AI_PROVIDER_KEY_ENV}"\\)|process\\.env\\.${AI_PROVIDER_KEY_ENV}`,
      ),
    );
  });
});
