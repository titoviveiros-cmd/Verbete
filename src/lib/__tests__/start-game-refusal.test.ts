import { afterEach, describe, expect, it, vi } from "vitest";
import type { Player, Room } from "@/lib/room";

// Mínimo de 4 (playtest 2026-10-20): quando o servidor recusa o start_game, o
// "choosing" otimista só é desfeito se a mesa continua no lobby. Partida que
// JÁ começou (invalid_state: outra aba, clique duplo, resposta perdida) não
// pode voltar ao lobby na tela do host.
const h = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: () => Promise.resolve(h.result) },
}));

import { startGame } from "@/lib/room";

const room = { id: "room-1", current_coordinator: null } as Room;
const players = ["a", "b", "c", "d"].map(
  (id) => ({ id, score: 3, coordinator_count: 1 }) as Player,
);

function statuses() {
  const seen: string[] = [];
  const on = (e: Event) =>
    seen.push(
      (e as CustomEvent<{ patch: { status: string } }>).detail.patch.status,
    );
  window.addEventListener("room:optimistic-update", on);
  return {
    seen,
    off: () => window.removeEventListener("room:optimistic-update", on),
  };
}

describe("startGame — recusa do servidor", () => {
  let spy: ReturnType<typeof statuses> | null = null;
  afterEach(() => spy?.off());

  it("min_players: desfaz o otimista (volta ao lobby) e avisa o motivo", async () => {
    h.result = { data: { ok: false, reason: "min_players" }, error: null };
    spy = statuses();
    await expect(startGame(room, players)).rejects.toThrow(/min_players/);
    expect(spy.seen).toEqual(["choosing", "lobby"]);
  });

  it("not_authorized: também volta ao lobby", async () => {
    h.result = { data: { ok: false, reason: "not_authorized" }, error: null };
    spy = statuses();
    await expect(startGame(room, players)).rejects.toThrow(/not_authorized/);
    expect(spy.seen).toEqual(["choosing", "lobby"]);
  });

  it("invalid_state (a partida já começou): NÃO volta ao lobby", async () => {
    h.result = { data: { ok: false, reason: "invalid_state" }, error: null };
    spy = statuses();
    await expect(startGame(room, players)).rejects.toThrow(/invalid_state/);
    expect(spy.seen).toEqual(["choosing"]);
  });

  it("erro de rede: volta ao lobby (o poll corrige se o servidor começou)", async () => {
    h.result = { data: null, error: { message: "fetch failed" } };
    spy = statuses();
    await expect(startGame(room, players)).rejects.toThrow(/fetch failed/);
    expect(spy.seen).toEqual(["choosing", "lobby"]);
  });

  it("ok: segue em choosing, sem erro", async () => {
    h.result = { data: { ok: true, coordinator: "a" }, error: null };
    spy = statuses();
    await expect(startGame(room, players)).resolves.toBeUndefined();
    expect(spy.seen).toEqual(["choosing"]);
  });
});
