import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCoalescer,
  createLatestGate,
  nudgePayload,
  nudgeRoundSync,
  NUDGE_EVENT,
} from "@/lib/sync-nudge";

// Aviso "há estado novo, releia do servidor" (playtest 2026-10-22).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("aviso de sincronização", () => {
  it("vários avisos juntos = UMA leitura (sem tempestade de pedidos)", () => {
    const read = vi.fn();
    const nudge = createCoalescer(read, 100);
    for (let i = 0; i < 10; i++) nudge();
    vi.advanceTimersByTime(100);
    expect(read).toHaveBeenCalledTimes(1);
    nudge();
    vi.advanceTimersByTime(100);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("resposta fora de ordem não desfaz a mais nova", () => {
    const gate = createLatestGate();
    const old = gate.next();
    const fresh = gate.next();
    expect(gate.accept(fresh)).toBe(true);
    expect(gate.accept(old)).toBe(false);
  });

  it("o aviso não leva texto, autor, verdade nem significado — só sala, rodada, tipo e versão", () => {
    const p = nudgePayload("sala-1", 3, "definition", 123);
    expect(Object.keys(p).sort()).toEqual(["kind", "room_id", "round", "v"]);
    expect(p).toEqual({
      room_id: "sala-1",
      round: 3,
      kind: "definition",
      v: 123,
    });
  });

  it("a ação confirmada vira um evento local (o canal da sala é quem transmite)", () => {
    const seen = vi.fn();
    window.addEventListener(NUDGE_EVENT, seen);
    nudgeRoundSync("sala-1", 2, "vote");
    window.removeEventListener(NUDGE_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      roomId: "sala-1",
      round: 2,
      kind: "vote",
    });
  });
});
