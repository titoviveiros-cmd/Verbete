import { afterEach, describe, expect, it, vi } from "vitest";

// A escolha da palavra abre a escrita com prazo otimista igual ao do
// servidor (public.writing_phase_secs): base + 10 s, sem nº de jogadores.
const rpc = vi.hoisted(() =>
  vi.fn(async () => ({ data: { ok: true }, error: null })),
);
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

import { chooseWord } from "../room";

afterEach(() => {
  vi.useRealTimers();
});

describe("chooseWord — prazo da escrita", () => {
  it("otimismo de 70 s (60 + 10) e o servidor recebe a base 60", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const patches: Array<Record<string, unknown>> = [];
    const onPatch = (e: Event) =>
      patches.push((e as CustomEvent).detail.patch as Record<string, unknown>);
    window.addEventListener("room:optimistic-update", onPatch);
    await chooseWord("r1", "w1");
    window.removeEventListener("room:optimistic-update", onPatch);
    const writing = patches.find((p) => p.status === "writing");
    expect(writing).toBeTruthy();
    const secs =
      (Date.parse(String(writing!.round_phase_ends_at)) - Date.now()) / 1000;
    expect(secs).toBe(70);
    expect(rpc).toHaveBeenCalledWith("choose_word", {
      p_room_id: "r1",
      p_word_id: "w1",
      p_duration_sec: 60,
    });
  });
});
