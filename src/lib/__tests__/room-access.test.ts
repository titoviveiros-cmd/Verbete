import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// ECA Digital B4 (11/11/2026): sala privada por convite como padrão, dono
// tranca, "jogar só com bots", partida rápida fechada. O servidor garante
// (migration 20261111140000; suíte scripts/test-sala-trancada.mjs na CI);
// aqui: regra do app, otimismo/rollback e o texto da migration.
const h = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
  calls: [] as Array<{ fn: string; args: unknown }>,
  bots: [] as number[],
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: async (fn: string, args: unknown) => {
      h.calls.push({ fn, args });
      return h.result;
    },
  },
}));
vi.mock("@/lib/room", () => ({
  addBot: async (_room: string, _actor: string, index: number) => {
    h.bots.push(index);
  },
}));

import {
  RoomLockError,
  ageLockRequired,
  playOnlyWithBots,
  publicMatchAllowed,
  roomPrivacyLabel,
  setRoomLocked,
} from "@/lib/room-access";
import { friendlyEntryError } from "@/lib/entry-errors";

function patches() {
  const seen: unknown[] = [];
  const on = (e: Event) =>
    seen.push((e as CustomEvent<{ patch: unknown }>).detail.patch);
  window.addEventListener("room:optimistic-update", on);
  return {
    seen,
    off: () => window.removeEventListener("room:optimistic-update", on),
  };
}

afterEach(() => {
  h.calls.length = 0;
  h.bots.length = 0;
  h.result = { data: null, error: null };
});

describe("publicMatchAllowed (partida rápida atrás de escolha explícita, só 18+)", () => {
  it("fechada enquanto o servidor estiver fechado, mesmo para adulto que escolheu", () => {
    expect(
      publicMatchAllowed({
        ageBand: "adult",
        explicitOptIn: true,
        serverOpen: false,
      }),
    ).toBe(false);
  });
  it("nunca para menor, idade desconhecida ou sem escolha explícita", () => {
    for (const ageBand of ["under13", "teen", "unknown"] as const)
      expect(
        publicMatchAllowed({ ageBand, explicitOptIn: true, serverOpen: true }),
      ).toBe(false);
    expect(
      publicMatchAllowed({
        ageBand: "adult",
        explicitOptIn: false,
        serverOpen: true,
      }),
    ).toBe(false);
  });
  it("só adulto + escolha + servidor aberto", () => {
    expect(
      publicMatchAllowed({
        ageBand: "adult",
        explicitOptIn: true,
        serverOpen: true,
      }),
    ).toBe(true);
  });
});

describe("trancar a sala", () => {
  it("rótulo de privacidade: privada por padrão, trancada quando o dono tranca", () => {
    expect(roomPrivacyLabel(false)).toMatch(/código ou o link/);
    expect(roomPrivacyLabel(true)).toMatch(/ninguém novo entra/);
  });
  it("otimismo + RPC set_room_locked com o ator", async () => {
    h.result = { data: { ok: true, locked: true }, error: null };
    const spy = patches();
    await setRoomLocked("room-1", "p-host", true);
    spy.off();
    expect(h.calls).toEqual([
      {
        fn: "set_room_locked",
        args: { p_room_id: "room-1", p_actor_id: "p-host", p_locked: true },
      },
    ]);
    expect(spy.seen).toEqual([{ locked: true }]);
  });
  it("recusa do servidor desfaz o otimismo e explica", async () => {
    h.result = { data: { ok: false, reason: "not_host" }, error: null };
    const spy = patches();
    await expect(setRoomLocked("room-1", "p-x", true)).rejects.toThrow(
      RoomLockError,
    );
    spy.off();
    expect(spy.seen).toEqual([{ locked: true }, { locked: false }]);
  });
  it("jogar só com bots: tranca ANTES de chamar os bots", async () => {
    h.result = { data: { ok: true }, error: null };
    await playOnlyWithBots("room-1", "p-host", 1, 3);
    expect(h.calls[0]!.fn).toBe("set_room_locked");
    expect(h.bots).toEqual([1, 2, 3]);
  });
  it("se não trancar, não chama bots", async () => {
    h.result = { data: null, error: { message: "x" } };
    await expect(playOnlyWithBots("room-1", "p-host", 1, 3)).rejects.toThrow();
    expect(h.bots).toEqual([]);
  });
});

describe("mensagens de entrada", () => {
  it("sala trancada e partida rápida fechada têm texto próprio", () => {
    expect(friendlyEntryError({ message: "room_locked" }, "join")).toMatch(
      /trancada/,
    );
    expect(
      friendlyEntryError({ message: "public_rooms_closed" }, "join"),
    ).toMatch(/partida rápida/);
  });
});

describe("migration (o servidor é quem garante)", () => {
  const sql = readFileSync(
    "supabase/migrations/20261111140000_sala_trancada_partida_rapida.sql",
    "utf8",
  );
  it("gatilho em players cobre entrada nova e volta de expulso; bots passam", () => {
    expect(sql).toMatch(
      /BEFORE INSERT OR UPDATE OF kicked_at ON public\.players/,
    );
    expect(sql).toMatch(/IF NEW\.is_bot THEN RETURN NEW;/);
    expect(sql).toMatch(/RAISE EXCEPTION 'room_locked'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'public_rooms_closed'/);
  });
  it("set_room_locked: só o dono, nunca anon", () => {
    expect(sql).toMatch(/v_room\.host_id <> p_actor_id/);
    expect(sql).toMatch(/assert_actor_identity/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.set_room_locked\(uuid, text, boolean\) FROM PUBLIC, anon;/,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.set_room_locked[^;]*anon/,
    );
  });
  it("não reescreve funções de criar/entrar (PR #60 e limite de salas mexem nelas)", () => {
    for (const fn of [
      "create_room_with_host",
      "rejoin_room",
      "join_public_room",
    ])
      expect(sql).not.toMatch(new RegExp(`FUNCTION public\\.${fn}`));
  });
  it("partida rápida fechada por padrão", () => {
    expect(sql).toMatch(
      /current_setting\('verbete\.public_rooms_open', true\)/,
    );
  });
});

describe("ageLockRequired (integração B4 × B5: dono < 13 declarado → sala trancada)", () => {
  const base = { isHost: true, inRoom: true, locked: false } as const;
  it("tranca a sala do dono que declarou menos de 13", () => {
    expect(ageLockRequired({ ...base, ageBand: "under13" })).toBe(true);
  });
  it("não mexe em quem declarou 13+ nem em quem não declarou", () => {
    for (const ageBand of ["teen", "adult", "unknown"] as const)
      expect(ageLockRequired({ ...base, ageBand })).toBe(false);
  });
  it("só o dono, já dentro da sala, e só se ainda não estiver trancada", () => {
    expect(
      ageLockRequired({ ...base, ageBand: "under13", isHost: false }),
    ).toBe(false);
    expect(
      ageLockRequired({ ...base, ageBand: "under13", inRoom: false }),
    ).toBe(false);
    expect(ageLockRequired({ ...base, ageBand: "under13", locked: true })).toBe(
      false,
    );
  });
});
