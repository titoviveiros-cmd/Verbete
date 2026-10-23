import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Presença da pausa de partida: toque no app = 'active' (no máx. 1× a cada
// 15 s), app fora da tela = 'away' (beacon com keepalive), volta à tela =
// 'active' na hora. Só com partida em andamento e para humano ativo.
const h = vi.hoisted(() => ({
  touches: [] as string[],
  aways: 0,
}));
vi.mock("@/lib/presence", () => ({
  ACTIVE_THROTTLE_MS: 15_000,
  touchPresence: (_r: string, _p: string, s: string) => {
    h.touches.push(s);
    return Promise.resolve({ ok: true, resumed: false });
  },
  sendAwayBeacon: () => {
    h.aways++;
  },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { access_token: "jwt" } } }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
    },
  },
}));

import { usePausePresence } from "@/hooks/room/use-pause-presence";

function Probe(p: { inGame: boolean; activeHuman: boolean }) {
  usePausePresence({ roomId: "r1", playerId: "p1", ...p });
  return null;
}
const setVisibility = (v: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => v,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("presença para a pausa de partida", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.touches.length = 0;
    h.aways = 0;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("abre a partida = presente; toques seguidos não inundam o servidor", () => {
    render(<Probe inGame activeHuman />);
    expect(h.touches).toEqual(["active"]);
    act(() => {
      vi.advanceTimersByTime(5_000);
      document.dispatchEvent(new Event("pointerdown"));
      document.dispatchEvent(new Event("keydown"));
    });
    expect(h.touches).toEqual(["active"]); // dentro dos 15 s
    act(() => {
      vi.advanceTimersByTime(11_000);
      document.dispatchEvent(new Event("pointerdown"));
    });
    expect(h.touches).toEqual(["active", "active"]);
  });

  it("app sai da tela = 'away'; volta = 'active' na hora", () => {
    render(<Probe inGame activeHuman />);
    act(() => setVisibility("hidden"));
    expect(h.aways).toBe(1);
    act(() => setVisibility("visible"));
    expect(h.touches).toEqual(["active", "active"]);
  });

  it("fora de partida, bot ou expulso: não manda nada", () => {
    render(<Probe inGame={false} activeHuman />);
    render(<Probe inGame activeHuman={false} />);
    act(() => {
      document.dispatchEvent(new Event("pointerdown"));
      setVisibility("hidden");
    });
    expect(h.touches).toEqual([]);
    expect(h.aways).toBe(0);
  });
});
