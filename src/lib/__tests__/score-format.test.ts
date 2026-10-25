import { describe, expect, it } from "vitest";
import { formatPoints } from "../score-format";

describe("formatPoints — o valor que nunca quebra no placar", () => {
  it("singular só para 1; sinal explícito", () => {
    expect(formatPoints(1)).toBe("+1 pt");
    expect(formatPoints(2)).toBe("+2 pts");
    expect(formatPoints(3)).toBe("+3 pts");
    expect(formatPoints(6)).toBe("+6 pts");
    expect(formatPoints(-1)).toBe("-1 pt");
    expect(formatPoints(-2)).toBe("-2 pts");
  });
});
