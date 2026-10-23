import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_DEF_MAX_PER_ROUND,
  autoDefKey,
  prefetchAutoDefinition,
  resetAutoDefinitions,
  takeAutoDefinition,
} from "@/lib/auto-definition";

// "🤖 gerar definição automática" instantânea (playtest 2026-10-22): antes o
// toque esperava a edge e só caía na reserva depois de até 6 s.
const later = (ms: number, text: string) =>
  new Promise<string>((r) => setTimeout(() => r(text), ms));
const fallback = vi.fn(async () => "reserva local");
const K1 = autoDefKey("sala", 1, "p1", "w1");
const K2 = autoDefKey("sala", 2, "p1", "w2");
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  resetAutoDefinitions();
  fallback.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("definição automática antecipada", () => {
  it("começa a gerar ao entrar na escrita — uma vez só", () => {
    const gen = vi.fn(() => later(3000, "sugestao da ia"));
    prefetchAutoDefinition(K1, gen);
    prefetchAutoDefinition(K1, gen);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("pronta quando o jogador toca → sai na hora, sem espera", async () => {
    prefetchAutoDefinition(K1, () => later(3000, "sugestao da ia"));
    await vi.advanceTimersByTimeAsync(3000);
    const t0 = Date.now();
    const got = await takeAutoDefinition(K1, {
      generate: () => later(9, "x"),
      fallback,
    });
    expect(got).toEqual({ text: "sugestao da ia", source: "pronta" });
    expect(Date.now() - t0).toBe(0);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("ainda gerando → espera curta e usa a resposta se chegar", async () => {
    prefetchAutoDefinition(K1, () => later(1500, "chegou a tempo"));
    await vi.advanceTimersByTimeAsync(1000);
    const p = takeAutoDefinition(K1, {
      generate: () => later(9, "x"),
      fallback,
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toEqual({ text: "chegou a tempo", source: "espera" });
  });

  it("sem resposta na janela → reserva local; a atrasada NÃO troca o texto, fica para o próximo toque", async () => {
    prefetchAutoDefinition(K1, () => later(4000, "chegou tarde"));
    const p = takeAutoDefinition(K1, {
      generate: () => later(9, "x"),
      fallback,
      waitMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ text: "reserva local", source: "reserva" });
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    const next = await takeAutoDefinition(K1, {
      generate: () => later(9, "x"),
      fallback,
    });
    expect(next).toEqual({ text: "chegou tarde", source: "pronta" });
  });

  it("troca de rodada descarta a sugestão velha (nunca aparece na palavra nova)", async () => {
    prefetchAutoDefinition(K1, () => later(100, "da rodada 1"));
    await vi.advanceTimersByTimeAsync(100);
    const p = takeAutoDefinition(K2, {
      generate: () => later(200, "da rodada 2"),
      fallback,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect((await p).text).toBe("da rodada 2");
  });

  it("não repete o que já está no campo nem nas sugestões da tela", async () => {
    prefetchAutoDefinition(K1, () => later(10, "ja mostrada"));
    await vi.advanceTimersByTimeAsync(10);
    const got = await takeAutoDefinition(K1, {
      generate: () => later(9, "x"),
      fallback,
      exclude: ["ja mostrada"],
    });
    expect(got.source).toBe("reserva");
  });

  it("QUASE igual a um 💡 da tela também não serve (não só o idêntico)", async () => {
    prefetchAutoDefinition(K1, () =>
      later(10, "pequeno animal que vive no fundo do rio"),
    );
    await vi.advanceTimersByTimeAsync(10);
    const got = await takeAutoDefinition(K1, {
      generate: () => later(9, "x"),
      fallback,
      exclude: ["pequeno animal que vive no fundo do mar"],
    });
    expect(got.source).toBe("reserva");
  });

  it("dois toques juntos (remontagem na espera) não jogam fora a reposição", async () => {
    const gen = vi.fn(() => later(500, "s"));
    prefetchAutoDefinition(K1, gen);
    const a = takeAutoDefinition(K1, { generate: gen, fallback });
    const b = takeAutoDefinition(K1, { generate: gen, fallback });
    await vi.advanceTimersByTimeAsync(500);
    await a;
    await b;
    // 1 antecipada + 1 reposição (antes: a 2ª retirada apagava a reposição
    // e gerava outra — 3 chamadas da IA)
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it("teto de gerações por rodada (cota da IA)", async () => {
    const gen = vi.fn(() => later(5, "s"));
    prefetchAutoDefinition(K1, gen);
    for (let i = 0; i < 6; i++) {
      const p = takeAutoDefinition(K1, {
        generate: gen,
        fallback,
        exclude: ["s"],
      });
      await vi.advanceTimersByTimeAsync(1000);
      await p;
    }
    expect(gen.mock.calls.length).toBeLessThanOrEqual(AUTO_DEF_MAX_PER_ROUND);
  });
});
