import { describe, expect, it } from "vitest";
import { phaseTimeFactor, scalePhaseSecs } from "../game-times";

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
