import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Definition, Player, Room, Word } from "@/lib/room";

// 🤖 "gerar definição automática" na tela de escrita (Red Team 2026-10-22):
// a antecipação não sai junto com a leva dos bots/💡, não gasta IA de quem
// já enviou e o resultado nunca apaga o que o jogador fez durante a espera.
const room = vi.hoisted(() => ({
  botSubmitDefinitions: vi.fn(),
  BOT_AI_GRACE_MS: 6000,
  generateAiDefinitionForPlayer: vi.fn(),
  startShuffling: vi.fn(() => Promise.resolve(true)),
  submitDefinition: vi.fn(() => Promise.resolve()),
  applyWritingTimeoutOrAdvance: vi.fn(() => Promise.resolve()),
  DuplicateDefinitionError: class extends Error {},
}));
vi.mock("@/lib/room", () => room);
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: () => new Promise(() => {}) },
    rpc: () => new Promise(() => {}),
  },
}));
// som/tato mudos: toda função exportada vira um vi.fn()
vi.mock("@/lib/sound", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn() : v,
    ]),
  );
});
vi.mock("@/components/Mascot", () => ({ Mascot: () => <div /> }));
vi.mock("@/components/VerbeteLogo", () => ({ VerbeteTile: () => <div /> }));

import { WriteDefinition } from "../WriteDefinition";
import {
  AUTO_DEF_PREFETCH_DELAY_MS,
  AUTO_DEF_WAIT_MS,
  resetAutoDefinitions,
} from "@/lib/auto-definition";

const ROOM = {
  id: "r1",
  code: "1234",
  status: "writing",
  current_round: 4,
  current_coordinator: "p_coord",
  current_word_id: "w1",
} as unknown as Room;
const ME = {
  id: "p_me",
  nickname: "Bia",
  avatar: "🦊",
  color: "#f0f",
  is_bot: false,
} as unknown as Player;
const COORD = {
  id: "p_coord",
  nickname: "Rui",
  avatar: "🐻",
  color: "#0ff",
  is_bot: false,
} as unknown as Player;
const WORD = { id: "w1", word: "rapape" } as Word;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 4; i++) {
      await vi.dynamicImportSettled();
      for (let j = 0; j < 5; j++) await Promise.resolve();
    }
  });
};
const wait = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
};
const show = (definitions: Definition[] = []) =>
  render(
    <WriteDefinition
      room={ROOM}
      players={[ME, COORD]}
      word={WORD}
      me={ME}
      isCoordinator={false}
      definitions={definitions}
      roundExtensions={[]}
      isHost={false}
      isDeputy={false}
    />,
  );
const field = () =>
  screen.getByPlaceholderText(
    "escreva sua definicao mirabolante...",
  ) as HTMLTextAreaElement;

beforeEach(() => {
  vi.useFakeTimers();
  resetAutoDefinitions();
  room.generateAiDefinitionForPlayer.mockReset();
  // a IA "pensa" para sempre: só a reserva local responde a tempo
  room.generateAiDefinitionForPlayer.mockImplementation(
    () => new Promise(() => {}),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WriteDefinition — 🤖 sugestão antecipada", () => {
  it("começa um pouco DEPOIS de entrar na escrita (não sai junto com os bots e os 💡)", async () => {
    show();
    await flush();
    expect(room.generateAiDefinitionForPlayer).not.toHaveBeenCalled();
    await wait(AUTO_DEF_PREFETCH_DELAY_MS);
    expect(room.generateAiDefinitionForPlayer).toHaveBeenCalledTimes(1);
  });

  it("quem já enviou (ex.: recarregou a página) não gasta IA", async () => {
    show([{ id: "d1", player_id: "p_me", round: 4 } as Definition]);
    await wait(AUTO_DEF_PREFETCH_DELAY_MS + 500);
    expect(room.generateAiDefinitionForPlayer).not.toHaveBeenCalled();
  });

  it("sem digitar: a reserva local entra no campo em até ~1 s", async () => {
    show();
    await wait(AUTO_DEF_PREFETCH_DELAY_MS);
    fireEvent.click(screen.getByText(/gerar definição automática/i));
    await flush();
    await wait(AUTO_DEF_WAIT_MS);
    expect(field().value.length).toBeGreaterThan(5);
  });

  it("digitou durante a espera: a sugestão NÃO apaga o que ele escreveu", async () => {
    show();
    await wait(AUTO_DEF_PREFETCH_DELAY_MS);
    fireEvent.click(screen.getByText(/gerar definição automática/i));
    await flush();
    fireEvent.change(field(), { target: { value: "minha propria ideia" } });
    await wait(AUTO_DEF_WAIT_MS);
    expect(field().value).toBe("minha propria ideia");
  });
});
