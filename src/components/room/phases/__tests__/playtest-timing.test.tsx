import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Definition, Player, Room, Word } from "@/lib/room";

// Playtest 2026-10-20 — tempos que o jogador SENTE, com relógio controlado:
// as 3 palavras já buscadas quando a transição termina, o embaralhamento
// visível ~2 s igual para host e convidados, e a transição de fase nova.
const room = vi.hoisted(() => ({
  fetchThreeWords: vi.fn(),
  chooseWord: vi.fn(() => Promise.resolve()),
  startVoting: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/room", () => room);
const sound = vi.hoisted(() => ({
  playUITap: vi.fn(),
  playCardShuffle: vi.fn(),
  hapticTick: vi.fn(),
}));
vi.mock("@/lib/sound", () => sound);
vi.mock("@/components/Mascot", () => ({
  Mascot: ({ mood }: { mood?: string }) => <div data-mascot={mood} />,
}));
vi.mock("@/components/VerbeteLogo", () => ({ VerbeteTile: () => <div /> }));

import { ChooseWord, FLIP_MIN_MS } from "../ChooseWord";
import {
  SHUFFLE_GUEST_FALLBACK_MS,
  SHUFFLE_HOLD_MS,
  Shuffling,
} from "../Shuffling";
import {
  PHASE_ANNOUNCER_TOTAL_MS,
  PhaseAnnouncer,
} from "@/components/room/PhaseAnnouncer";

const ROOM = {
  id: "r1",
  code: "1234",
  status: "choosing",
  current_round: 4,
  current_coordinator: "p_me",
  used_word_ids: ["velha"],
  categories: ["animal"],
  nivel: "medio",
} as unknown as Room;
const PLAYERS = [
  { id: "p_me", nickname: "Bia", avatar: "🦊", color: "#f0f" },
] as Player[];
const WORDS = [
  { id: "w1", word: "alvíssaras" },
  { id: "w2", word: "quiproquó" },
  { id: "w3", word: "zarabatana" },
] as Word[];

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
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};
const wait = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  room.fetchThreeWords.mockReset();
  room.startVoting.mockClear();
  sound.playCardShuffle.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChooseWord — as 3 palavras prontas quando a transição termina", () => {
  it("o coordenador já busca ao abrir a fase (antes do toque), com as regras da sala", () => {
    room.fetchThreeWords.mockReturnValue(new Promise(() => {}));
    render(<ChooseWord room={ROOM} players={PLAYERS} isCoordinator />);
    expect(room.fetchThreeWords).toHaveBeenCalledTimes(1);
    expect(room.fetchThreeWords).toHaveBeenCalledWith(
      ["velha"],
      ["animal"],
      "r1",
      "medio",
    );
  });

  it("quem não coordena não busca nada", () => {
    render(<ChooseWord room={ROOM} players={PLAYERS} isCoordinator={false} />);
    expect(room.fetchThreeWords).not.toHaveBeenCalled();
  });

  it("palavras já em mãos: o toque mostra as 3 depois do folhear curto, sem nova busca", async () => {
    room.fetchThreeWords.mockResolvedValue(WORDS);
    const { rerender } = render(
      <ChooseWord room={ROOM} players={PLAYERS} isCoordinator />,
    );
    await flush();
    // a sala chega de novo pelo realtime (novo objeto): não busca de novo
    rerender(<ChooseWord room={{ ...ROOM }} players={PLAYERS} isCoordinator />);
    fireEvent.click(screen.getByRole("button", { name: /Sortear palavra/ }));
    expect(screen.getByText(/Folheando o dicionário/)).toBeTruthy();
    await wait(FLIP_MIN_MS - 1);
    expect(screen.queryByText("quiproquó")).toBeNull();
    await wait(1);
    expect(screen.getByText("quiproquó")).toBeTruthy();
    expect(room.fetchThreeWords).toHaveBeenCalledTimes(1);
    // antes eram 1,8 s fixos depois do toque
    expect(FLIP_MIN_MS).toBeLessThanOrEqual(800);
  });

  it("a rede ainda não respondeu no toque: mostra assim que chegar", async () => {
    const d = deferred<Word[]>();
    room.fetchThreeWords.mockReturnValue(d.promise);
    render(<ChooseWord room={ROOM} players={PLAYERS} isCoordinator />);
    fireEvent.click(screen.getByRole("button", { name: /Sortear palavra/ }));
    await wait(FLIP_MIN_MS + 500);
    expect(screen.queryByText("quiproquó")).toBeNull();
    d.resolve(WORDS);
    await flush();
    expect(screen.getByText("quiproquó")).toBeTruthy();
  });

  it("a pré-busca falhou: o toque busca de novo", async () => {
    room.fetchThreeWords
      .mockRejectedValueOnce(new Error("rede"))
      .mockResolvedValueOnce(WORDS);
    render(<ChooseWord room={ROOM} players={PLAYERS} isCoordinator />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Sortear palavra/ }));
    await wait(FLIP_MIN_MS);
    expect(room.fetchThreeWords).toHaveBeenCalledTimes(2);
    expect(screen.getByText("quiproquó")).toBeTruthy();
  });

  it("falhou de novo: o botão volta para tentar outra vez (não trava folheando)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    room.fetchThreeWords.mockRejectedValue(new Error("rede"));
    render(<ChooseWord room={ROOM} players={PLAYERS} isCoordinator />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Sortear palavra/ }));
    await wait(FLIP_MIN_MS);
    expect(
      screen.getByRole("button", { name: /Sortear palavra/ }),
    ).toBeTruthy();
  });
});

describe("Shuffling — ~2 s na tela, igual para host e convidados", () => {
  const word = { id: "w1", word: "rapapé" } as Word;
  const defs = [] as Definition[];
  const shuffleRoom = {
    ...ROOM,
    status: "shuffling",
    current_round: 3,
  } as Room;

  it("o host só abre a votação depois do embaralhamento (antes: 0,4 s)", async () => {
    render(
      <Shuffling room={shuffleRoom} word={word} definitions={defs} isHost />,
    );
    await wait(SHUFFLE_HOLD_MS - 1);
    expect(room.startVoting).not.toHaveBeenCalled();
    await wait(1);
    expect(room.startVoting).toHaveBeenCalledTimes(1);
    expect(room.startVoting).toHaveBeenCalledWith("r1", 3, word, defs);
  });

  it("o poll troca as cédulas a cada 0,7 s: o relógio NÃO recomeça (abre uma vez, um som)", async () => {
    // get_round_sync entrega um array NOVO a cada poll; com as cédulas nas
    // dependências do efeito, o relógio de 1,8 s recomeçava sem fim.
    const { rerender } = render(
      <Shuffling room={shuffleRoom} word={word} definitions={[]} isHost />,
    );
    for (let t = 0; t < 2800; t += 700) {
      await wait(700);
      rerender(
        <Shuffling
          room={{ ...shuffleRoom }}
          word={{ ...word }}
          definitions={[] as Definition[]}
          isHost
        />,
      );
    }
    expect(room.startVoting).toHaveBeenCalledTimes(1);
    expect(sound.playCardShuffle).toHaveBeenCalledTimes(1);
  });

  it("convidado não corre com o host: só cobre a falta dele, bem depois", async () => {
    render(
      <Shuffling
        room={shuffleRoom}
        word={word}
        definitions={defs}
        isHost={false}
      />,
    );
    await wait(SHUFFLE_HOLD_MS + 1000);
    expect(room.startVoting).not.toHaveBeenCalled();
    await wait(SHUFFLE_GUEST_FALLBACK_MS - SHUFFLE_HOLD_MS - 1000);
    expect(room.startVoting).toHaveBeenCalledTimes(1);
  });

  it("a votação abriu (a tela saiu): ninguém chama de novo", async () => {
    const { unmount } = render(
      <Shuffling
        room={shuffleRoom}
        word={word}
        definitions={defs}
        isHost={false}
      />,
    );
    await wait(SHUFFLE_HOLD_MS + 500);
    unmount();
    await wait(10_000);
    expect(room.startVoting).not.toHaveBeenCalled();
  });

  it("fica visível na faixa pedida (1,8–2,5 s com a ida ao banco)", () => {
    // hold do host + ~0,3–0,5 s de RPC e realtime até a votação chegar
    expect(SHUFFLE_HOLD_MS).toBeGreaterThanOrEqual(1500);
    expect(SHUFFLE_HOLD_MS + 300).toBeLessThanOrEqual(2500);
    expect(SHUFFLE_GUEST_FALLBACK_MS - SHUFFLE_HOLD_MS).toBeGreaterThanOrEqual(
      1500,
    );
  });
});

describe("PhaseAnnouncer — transição da marca, curta", () => {
  const status = () => screen.getByRole("status");

  it("anuncia a fase com a rodada e sai em ~2,2 s", async () => {
    const { rerender } = render(<PhaseAnnouncer status="lobby" round={0} />);
    rerender(<PhaseAnnouncer status="choosing" round={3} />);
    expect(status().textContent).toBe("Escolha da Palavra");
    expect(screen.getByText("Rodada 3")).toBeTruthy();
    expect(screen.getByText(/palavra rara/)).toBeTruthy();
    await wait(2199);
    expect(status().textContent).toBe("Escolha da Palavra");
    await wait(1);
    expect(status().textContent).toBe("");
  });

  it("mascote da marca, sem o emoji gigante genérico", () => {
    const { rerender, container } = render(
      <PhaseAnnouncer status="choosing" />,
    );
    rerender(<PhaseAnnouncer status="writing" round={2} />);
    expect(container.querySelector("[data-mascot]")).toBeTruthy();
    for (const e of ["📖", "✍️", "🏆", "🎉"])
      expect(container.textContent).not.toContain(e);
  });

  it("sem cortina no embaralhamento, na votação e na revelação", () => {
    const { rerender } = render(<PhaseAnnouncer status="writing" />);
    for (const s of ["shuffling", "voting", "reveal"]) {
      rerender(<PhaseAnnouncer status={s} />);
      expect(screen.queryByRole("status")).toBeNull();
    }
  });

  it("a constante cobre a transição inteira (o placar só conta depois dela)", () => {
    expect(PHASE_ANNOUNCER_TOTAL_MS).toBeGreaterThanOrEqual(2200 + 450);
    expect(PHASE_ANNOUNCER_TOTAL_MS).toBeLessThan(3800);
  });
});
