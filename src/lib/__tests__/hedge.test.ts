import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEDGE_AFTER_MS, hedged } from "@/lib/hedge";

// "Segunda via" para leituras presas na rede (medição de 2026-10-20: a busca
// das palavras da sala travou 25,9 s enquanto outras voltavam em ~250 ms).
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("hedged — leitura com segunda via", () => {
  it("resposta rápida: uma chamada só", async () => {
    const run = vi.fn(() => Promise.resolve("ok"));
    await expect(hedged(run)).resolves.toBe("ok");
    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("1ª presa: a 2ª sai no tempo e vale a que chegar primeiro", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const run = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const p = hedged(run);
    await flush();
    vi.advanceTimersByTime(HEDGE_AFTER_MS - 1);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    second.resolve("segunda");
    await expect(p).resolves.toBe("segunda");
    first.resolve("primeira (atrasada, ignorada)");
    await flush();
  });

  it("1ª falha antes da hora: a 2ª sai na hora", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("rede"))
      .mockResolvedValueOnce("ok");
    await expect(hedged(run)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("as duas falham: devolve o erro; nunca mais de 2 tentativas", async () => {
    const run = vi.fn(() => Promise.reject(new Error("fora do ar")));
    await expect(hedged(run)).rejects.toThrow("fora do ar");
    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
