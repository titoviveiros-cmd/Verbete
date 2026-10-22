import { describe, expect, it } from "vitest";
import {
  clearRoomOptimistic,
  isStaleServerPhase,
  markRoomOptimistic,
  mergeSamePhasePoll,
  NARRATIVE_MIN_VISIBLE_MS,
  OPTIMISTIC_GRACE_MS,
  roomPhaseSig,
  shuffleAdvanceDelayMs,
} from "@/lib/transition-floor";

// Coordenador bot (playtest 2026-10-22): o processamento pode terminar cedo;
// a transição visual não some cedo — e nenhuma leitura atrasada desfaz uma
// virada que o próprio aparelho acabou de fazer.
const CURTAIN = 3500; // PHASE_ANNOUNCER_TOTAL_MS

describe("piso da escrita antes do embaralhamento", () => {
  it("só bots escrevendo: a escrita fica ≥ 2,5 s à vista depois da cortina", () => {
    const seen = 1_000_000;
    const allIn = seen + 1_000; // bots entregam ~1 s depois da virada
    const delay = shuffleAdvanceDelayMs(true, seen, allIn, CURTAIN);
    const visible = allIn + delay - (seen + CURTAIN);
    expect(visible).toBeGreaterThanOrEqual(NARRATIVE_MIN_VISIBLE_MS);
    expect(visible).toBeLessThan(NARRATIVE_MIN_VISIBLE_MS + 100);
  });

  it("escrita demorada (humanos): nenhuma espera a mais", () => {
    const seen = 1_000_000;
    expect(shuffleAdvanceDelayMs(true, seen, seen + 30_000, CURTAIN)).toBe(600);
    expect(shuffleAdvanceDelayMs(false, seen, seen + 30_000, CURTAIN)).toBe(
      1800,
    );
  });

  it("quem cobre a falta do host continua depois dele", () => {
    const seen = 1_000_000;
    const now = seen + 1_000;
    expect(shuffleAdvanceDelayMs(false, seen, now, CURTAIN)).toBeGreaterThan(
      shuffleAdvanceDelayMs(true, seen, now, CURTAIN),
    );
  });
});

describe("leitura periódica não desfaz a virada otimista", () => {
  const server = {
    status: "choosing",
    current_round: 1,
    current_word_id: null,
    round_phase_ends_at: "2026-10-22T12:01:00.000Z",
    current_coordinator: "bot_tio",
    host_id: "p_host",
    paused_at: null,
  };
  // o host escolheu (otimista): fase e timer locais à frente do servidor
  const optimistic = {
    ...server,
    status: "writing",
    current_word_id: "w1",
    round_phase_ends_at: "2026-10-22T12:02:00.000Z",
  };

  it("logo depois da escolha, a leitura com a fase antiga não volta a tela", () => {
    const t = 5_000_000;
    markRoomOptimistic(roomPhaseSig(server), t);
    const next = mergeSamePhasePoll(optimistic, server, t + 2_500);
    expect(next.status).toBe("writing");
    expect(next).toBe(optimistic);
  });

  it("otimismo que não vingou: passada a janela, o servidor vence", () => {
    const t = 6_000_000;
    markRoomOptimistic(roomPhaseSig(server), t);
    const next = mergeSamePhasePoll(
      optimistic,
      server,
      t + OPTIMISTIC_GRACE_MS + 1,
    );
    expect(next.status).toBe("choosing");
    expect(next.current_word_id).toBeNull();
  });

  it("outra fase do servidor (outro aparelho escolheu primeiro) vale na hora", () => {
    const t = 8_000_000;
    markRoomOptimistic(roomPhaseSig(server), t);
    const winner = { ...server, status: "writing", current_word_id: "w2" };
    expect(isStaleServerPhase(winner, t + 300)).toBe(false);
    expect(
      mergeSamePhasePoll(optimistic, winner, t + 300).current_word_id,
    ).toBe("w2");
  });

  it("escolha recusada pelo servidor: a leitura seguinte corrige na hora", () => {
    const t = 9_000_000;
    markRoomOptimistic(roomPhaseSig(server), t);
    expect(isStaleServerPhase(server, t + 300)).toBe(true);
    clearRoomOptimistic();
    expect(isStaleServerPhase(server, t + 300)).toBe(false);
    expect(mergeSamePhasePoll(optimistic, server, t + 300).status).toBe(
      "choosing",
    );
  });

  it("mesma fase: campos secundários (timer, coordenador, pausa) entram", () => {
    const t = 7_000_000;
    markRoomOptimistic(roomPhaseSig(server), t);
    const paused = { ...server, paused_at: "2026-10-22T12:00:30.000Z" };
    expect(mergeSamePhasePoll(server, paused, t + 100).paused_at).toBe(
      paused.paused_at,
    );
    const same = { ...server };
    expect(mergeSamePhasePoll(server, same, t + 100)).toBe(server);
  });
});
