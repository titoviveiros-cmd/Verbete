import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Player, Room } from "@/lib/room";

// Placar sem o detalhamento num aparelho (playtest 2026-10-22). O Supabase de
// mentira responde com o "estado do servidor" do teste e aceita falhas
// programadas: erro, leitura PRESA (só sai se cancelada) — sempre a próxima
// chamada daquela leitura.
const h = vi.hoisted(() => {
  const state = {
    defs: [] as unknown[],
    votes: [] as unknown[],
    rounds: [] as unknown[],
    near: [] as string[],
    exts: [] as unknown[],
  };
  const faults: Array<{ name: string; kind: "fail" | "hang" }> = [];
  const log: string[] = [];
  const dataOf = (name: string): unknown => {
    switch (name) {
      case "rpc:get_room_definitions":
        return state.defs;
      case "from:votes":
        return state.votes;
      case "from:rounds":
        return state.rounds;
      case "rpc:get_room_reveal":
        return {
          available: true,
          truth_def_ids: [],
          near_truth_ids: state.near,
        };
      default:
        return state.exts;
    }
  };
  const make = (name: string) => {
    log.push(name);
    const i = faults.findIndex((f) => f.name === name);
    const fault = i >= 0 ? faults.splice(i, 1)[0] : undefined;
    let resolve!: (v: unknown) => void;
    const p = new Promise((r) => (resolve = r));
    const snapshot = JSON.parse(JSON.stringify(dataOf(name)));
    if (fault?.kind === "fail")
      queueMicrotask(() => resolve({ data: null, error: { message: "503" } }));
    else if (!fault)
      queueMicrotask(() => resolve({ data: snapshot, error: null }));
    const q = {
      abortSignal(sig: AbortSignal) {
        sig.addEventListener("abort", () =>
          resolve({ data: null, error: { message: "AbortError" } }),
        );
        return q;
      },
      then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) =>
        p.then(a, b),
    };
    return q;
  };
  const from = (table: string) => {
    const q = {
      select: () => q,
      eq: () => make(`from:${table}`),
    };
    return q;
  };
  return {
    state,
    faults,
    log,
    supabase: {
      from,
      rpc: (name: string) => make(`rpc:${name}`),
    },
  };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: h.supabase }));
vi.mock("@/lib/sound", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn() : v,
    ]),
  );
});

import { Scoreboard } from "../Scoreboard";

// Rodada 1: coordenadora Cris; Ana acerta a verdade (+3) e engana o Beto (+1).
// Rodada 2: coordenadora Ana, ninguém acerta (+2 para ela); Beto e Cris se
// enganam (+1 cada).
const T = "__truth__";
const R1 = {
  defs: [
    { id: "t1", round: 1, player_id: T, letter: "A", text: "verdade um" },
    { id: "a1", round: 1, player_id: "ana", letter: "B", text: "blefe ana" },
    { id: "b1", round: 1, player_id: "beto", letter: "C", text: "blefe beto" },
  ],
  votes: [
    { id: "v1", round: 1, voter_id: "ana", definition_id: "t1" },
    { id: "v2", round: 1, voter_id: "beto", definition_id: "a1" },
  ],
  rounds: [{ round: 1, coordinator_id: "cris", scored_at: "2026-10-22" }],
};
const R2 = {
  defs: [
    { id: "t2", round: 2, player_id: T, letter: "A", text: "verdade dois" },
    { id: "b2", round: 2, player_id: "beto", letter: "B", text: "blefe b2" },
    { id: "c2", round: 2, player_id: "cris", letter: "C", text: "blefe c2" },
  ],
  votes: [
    { id: "v3", round: 2, voter_id: "beto", definition_id: "c2" },
    { id: "v4", round: 2, voter_id: "cris", definition_id: "b2" },
  ],
  rounds: [{ round: 2, coordinator_id: "ana", scored_at: "2026-10-22" }],
};
const serve = (...rs: Array<typeof R1>) => {
  h.state.defs = rs.flatMap((r) => r.defs);
  h.state.votes = rs.flatMap((r) => r.votes);
  h.state.rounds = rs.flatMap((r) => r.rounds);
  h.state.near = [];
  h.state.exts = [];
};
const P = (id: string, nickname: string, score: number) =>
  ({ id, nickname, score, avatar: "🦊", color: "#f0f" }) as unknown as Player;
const players1 = () => [
  P("ana", "Ana", 4),
  P("beto", "Beto", 0),
  P("cris", "Cris", 0),
];
const players2 = () => [
  P("ana", "Ana", 6),
  P("beto", "Beto", 1),
  P("cris", "Cris", 1),
];
const room = (round: number, status = "scoreboard") =>
  ({
    id: "sala",
    code: "1234",
    status,
    current_round: round,
  }) as unknown as Room;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 4; i++) {
      await vi.dynamicImportSettled();
      for (let j = 0; j < 8; j++) await Promise.resolve();
    }
  });
};
const wait = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
};
const chipsOf = (root: HTMLElement, name: string) =>
  Array.from(root.querySelectorAll(".sticker"))
    .find(
      (el) => el.querySelector(".font-display.text-xl")?.textContent === name,
    )
    ?.querySelectorAll("li.chip") ?? [];
const lines = (root: HTMLElement, name: string) =>
  Array.from(chipsOf(root, name)).map((li) => li.textContent);
const loading = (root: HTMLElement) =>
  root.querySelector('[data-score-details="loading"]') !== null;
const calls = (name: string) => h.log.filter((n) => n === name).length;

const ANA_R1 = [
  "🎯 Acertou a verdade 1× → +3 pts",
  "🤥 Enganou jogadores 1× → +1 pts",
];
const SEM = ["Ainda sem pontos — bora pra próxima! 💪"];

beforeEach(() => {
  vi.useFakeTimers();
  h.faults.length = 0;
  h.log.length = 0;
  serve(R1);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Placar — histórico consistente com nova tentativa", () => {
  it("A) histórico completo → placar completo", async () => {
    const { container } = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    expect(lines(container, "Ana")).toEqual(ANA_R1);
    expect(lines(container, "Beto")).toEqual(SEM);
    expect(loading(container)).toBe(false);
  });

  it("B) 1ª leitura falha → nada de linha falsa → nova tentativa → completo", async () => {
    h.faults.push({ name: "rpc:get_room_definitions", kind: "fail" });
    const { container } = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    // antes: as definições vinham vazias e a Ana aparecia "sem pontos"
    expect(lines(container, "Ana")).toEqual([]);
    expect(loading(container)).toBe(true);
    await wait(500);
    expect(lines(container, "Ana")).toEqual(ANA_R1);
    expect(loading(container)).toBe(false);
  });

  it("C) retrato ainda SEM a rodada corrente pontuada → carregando → nova tentativa → completo", async () => {
    h.state.rounds = []; // a pontuação da rodada 1 ainda não aparece na leitura
    const { container } = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    expect(lines(container, "Ana")).toEqual([]);
    expect(loading(container)).toBe(true);
    serve(R1);
    await wait(500);
    expect(lines(container, "Ana")).toEqual(ANA_R1);
  });

  it("D) UMA leitura com erro (votos) → não monta detalhamento com pedaço", async () => {
    h.faults.push({ name: "from:votes", kind: "fail" });
    const { container } = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    // sem os votos a Ana sairia "sem pontos" e o coordenador "ganharia" +2
    expect(lines(container, "Ana")).toEqual([]);
    expect(lines(container, "Cris")).toEqual([]);
    await wait(500);
    expect(lines(container, "Ana")).toEqual(ANA_R1);
    expect(lines(container, "Cris")).toEqual(SEM);
  });

  it("E) 🧠 que chega depois: o total muda, relê, e a linha +3 aparece UMA vez", async () => {
    const { container, rerender } = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    expect(lines(container, "Beto")).toEqual(SEM);
    h.state.near = ["b1"];
    const late = players1().map((p) =>
      p.id === "beto" ? { ...p, score: 3 } : p,
    );
    rerender(<Scoreboard room={room(1)} players={late} isHost={false} />);
    await wait(300);
    expect(lines(container, "Beto")).toEqual([
      "🧠 Chegou perto da verdade 1× → +3 pts",
    ]);
  });

  it("F) próxima rodada: o retrato velho não vale como o da rodada nova", async () => {
    const { container, rerender } = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    expect(lines(container, "Ana")).toEqual(ANA_R1);
    // rodada 2 pontuada, mas a 1ª leitura ainda devolve o retrato da rodada 1
    rerender(<Scoreboard room={room(2)} players={players2()} isHost={false} />);
    await flush();
    expect(lines(container, "Ana")).toEqual([]);
    expect(loading(container)).toBe(true);
    serve(R1, R2);
    await wait(500);
    expect(lines(container, "Ana")).toEqual([
      ...ANA_R1,
      "👑 Coordenou e ninguém acertou 1× → +2 pts",
    ]);
    expect(lines(container, "Beto")).toEqual([
      "🤥 Enganou jogadores 1× → +1 pts",
    ]);
  });

  it("leitura PRESA (o caso do playtest) → prazo → nova tentativa → completo", async () => {
    h.faults.push({ name: "rpc:get_room_definitions", kind: "hang" });
    const { container } = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    await wait(3000);
    // antes: o detalhamento esperava a leitura presa — placar sem linhas
    expect(lines(container, "Ana")).toEqual([]);
    expect(loading(container)).toBe(true);
    await wait(1200); // prazo de 3,5 s + 400 ms
    expect(lines(container, "Ana")).toEqual(ANA_R1);
  });

  it("sem laço: tudo falhando = 3 tentativas e PARA; volta à tela = nova rodada de no máx. 3", async () => {
    for (let i = 0; i < 6; i++)
      h.faults.push({ name: "rpc:get_room_reveal", kind: "fail" });
    const { container } = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    await wait(30_000);
    expect(calls("rpc:get_room_reveal")).toBe(3);
    expect(loading(container)).toBe(true);
    expect(lines(container, "Ana")).toEqual([]);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await wait(30_000);
    expect(calls("rpc:get_room_reveal")).toBe(6);
  });

  it("tempestade: 5 mudanças de pontos em sequência = 1 releitura", async () => {
    const { rerender } = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    const before = calls("rpc:get_room_definitions");
    for (let k = 1; k <= 5; k++) {
      const ps = players1().map((p) =>
        p.id === "beto" ? { ...p, score: k } : p,
      );
      rerender(<Scoreboard room={room(1)} players={ps} isHost={false} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
    }
    await wait(500);
    expect(calls("rpc:get_room_definitions") - before).toBe(1);
  });

  it("2 aparelhos: A lê normal; B tem a 1ª leitura presa → B converge para o MESMO placar de A", async () => {
    const a = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    h.faults.push({ name: "rpc:get_room_definitions", kind: "hang" });
    const b = render(
      <Scoreboard room={room(1)} players={players1()} isHost={false} />,
    );
    await flush();
    expect(lines(b.container, "Ana")).toEqual([]);
    await wait(4000);
    const order = (root: HTMLElement) =>
      Array.from(root.querySelectorAll(".sticker .font-display.text-xl")).map(
        (el) => el.textContent,
      );
    for (const n of ["Ana", "Beto", "Cris"])
      expect(lines(b.container, n)).toEqual(lines(a.container, n));
    expect(order(b.container)).toEqual(order(a.container));
    expect(lines(a.container, "Ana")).toEqual(ANA_R1);
  });
});
