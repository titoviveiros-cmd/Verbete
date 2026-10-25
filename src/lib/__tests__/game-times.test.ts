import { describe, expect, it } from "vitest";
import {
  WRITING_BASE_SECS,
  WRITING_EXTRA_SECS,
  phaseTimeFactor,
  scalePhaseSecs,
  writingPhaseSecs,
  writingTimerMax,
} from "../game-times";

// Escrita (2026-10-25): cada jogador escreve UMA definição — o tempo não
// cresce com a sala. Leitura (votação/revelação/placar) segue escalando.
describe("escrita: tempo fixo, independente do nº de jogadores", () => {
  it("é a base atual (60 s) + 10 s fixos = 70 s", () => {
    expect(WRITING_BASE_SECS).toBe(60);
    expect(WRITING_EXTRA_SECS).toBe(10);
    expect(writingPhaseSecs()).toBe(70);
    expect(writingPhaseSecs(60)).toBe(70);
  });

  it("barra da escrita: 70 s; prorrogações 20 s e 15 s — sem fator de sala", () => {
    expect(writingTimerMax(0)).toBe(70);
    expect(writingTimerMax(1)).toBe(20);
    expect(writingTimerMax(2)).toBe(15);
    expect(writingTimerMax(3)).toBe(15);
  });

  it("tabela 4–12 jogadores: escrita igual; votação e revelação crescem", () => {
    const rows = [4, 6, 8, 10, 12].map((n) => ({
      n,
      escrita: writingPhaseSecs(),
      votacao: scalePhaseSecs(30, n),
      revelacao: scalePhaseSecs(20, n),
    }));
    expect(new Set(rows.map((r) => r.escrita))).toEqual(new Set([70]));
    expect(rows.map((r) => r.votacao)).toEqual([30, 30, 40, 50, 60]);
    expect(rows.map((r) => r.revelacao)).toEqual([20, 20, 27, 33, 40]);
  });
});

describe("phaseTimeFactor", () => {
  it("mantém fator 1 até 6 jogadores (tempos originais intocados)", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6]) {
      expect(phaseTimeFactor(n)).toBe(1);
    }
  });

  it("cresce proporcionalmente de 7 a 12 jogadores", () => {
    expect(phaseTimeFactor(7)).toBeCloseTo(7 / 6);
    expect(phaseTimeFactor(9)).toBeCloseTo(1.5);
    expect(phaseTimeFactor(12)).toBe(2);
  });

  it("trava o fator no teto de 12 jogadores", () => {
    expect(phaseTimeFactor(20)).toBe(2);
  });
});

describe("scalePhaseSecs", () => {
  it("não altera os tempos de referência com sala pequena", () => {
    expect(scalePhaseSecs(30, 4)).toBe(30); // votação
    expect(scalePhaseSecs(60, 6)).toBe(60); // escrita/escolha
    expect(scalePhaseSecs(12, 2)).toBe(12); // hold da revelação
  });

  it("escala os tempos-chave nos extremos da faixa grande", () => {
    expect(scalePhaseSecs(30, 7)).toBe(35);
    expect(scalePhaseSecs(30, 12)).toBe(60);
    expect(scalePhaseSecs(60, 12)).toBe(120);
    expect(scalePhaseSecs(12, 12)).toBe(24);
    expect(scalePhaseSecs(8, 9)).toBe(12);
  });

  it("arredonda para o segundo inteiro mais próximo", () => {
    expect(scalePhaseSecs(20, 7)).toBe(23); // 23.33…
    expect(scalePhaseSecs(15, 10)).toBe(25);
  });
});
