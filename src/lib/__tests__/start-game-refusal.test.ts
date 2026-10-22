import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@/lib/room";

// Início da partida (playtest 2026-10-21): a sala só vira "choosing" com o
// coordenador AUTORITATIVO devolvido por start_game — nada de coordenador
// provisório sorteado no aparelho (ele trocava ~1,2 s depois e reiniciava a
// escolha do bot). Recusa do servidor = nada mudou na tela, nada a desfazer.
const h = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
  release: null as null | (() => void),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: () =>
      new Promise((resolve) => {
        h.release = () => resolve(h.result);
      }),
  },
}));

import { startGame } from "@/lib/room";

const room = { id: "room-1", current_coordinator: null } as Room;

function patches() {
  const seen: Array<{ status: string; current_coordinator?: string | null }> =
    [];
  const on = (e: Event) =>
    seen.push(
      (
        e as CustomEvent<{
          patch: { status: string; current_coordinator?: string | null };
        }>
      ).detail.patch,
    );
  window.addEventListener("room:optimistic-update", on);
  return {
    seen,
    off: () => window.removeEventListener("room:optimistic-update", on),
  };
}

async function run(result: { data: unknown; error: unknown }) {
  h.result = result;
  const spy = patches();
  const p = startGame(room);
  await Promise.resolve();
  const beforeServer = spy.seen.length;
  h.release?.();
  const outcome = await p.then(
    () => "ok",
    (e: Error) => e.message,
  );
  spy.off();
  return { beforeServer, seen: spy.seen, outcome };
}

describe("startGame — coordenador só o do servidor", () => {
  afterEach(() => {
    h.release = null;
  });

  it("nada muda na tela antes do servidor responder (sem provisório)", async () => {
    const r = await run({
      data: { ok: true, coordinator: "bot_tio" },
      error: null,
    });
    expect(r.beforeServer).toBe(0);
    expect(r.outcome).toBe("ok");
  });

  it("aceito: vira 'choosing' UMA vez, já com o coordenador do servidor", async () => {
    const r = await run({
      data: { ok: true, coordinator: "bot_tio" },
      error: null,
    });
    expect(r.seen).toEqual([
      {
        status: "choosing",
        current_round: 1,
        current_coordinator: "bot_tio",
        current_word_id: null,
      },
    ]);
  });

  it("recusado (min_players, not_authorized, invalid_state, rede): nada a desfazer", async () => {
    for (const result of [
      { data: { ok: false, reason: "min_players" }, error: null },
      { data: { ok: false, reason: "not_authorized" }, error: null },
      { data: { ok: false, reason: "invalid_state" }, error: null },
      { data: null, error: { message: "fetch failed" } },
    ]) {
      const r = await run(result);
      expect(r.seen).toEqual([]);
      expect(r.outcome).toMatch(
        /min_players|not_authorized|invalid_state|fetch failed/,
      );
    }
  });
});
