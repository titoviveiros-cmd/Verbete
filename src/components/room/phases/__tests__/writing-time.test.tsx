import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Player, Room, Word } from "@/lib/room";
import type { RoundExtension } from "@/hooks/use-room";

// Escrita com tempo fixo (2026-10-25): cada jogador escreve UMA definição —
// a barra da escrita tem o MESMO máximo com 4 ou com 12 jogadores (base +
// 10 s = 70 s; prorrogação 20 s / 15 s). Falha se alguém voltar a ligar o
// tempo da escrita ao nº de jogadores (o espelho do servidor tem o teste
// dele em scripts/test-phase-secs.mjs).
const room = vi.hoisted(() => ({
  botSubmitDefinitions: vi.fn(),
  BOT_AI_GRACE_MS: 6000,
  generateAiDefinitionForPlayer: vi.fn(() => new Promise(() => {})),
  startShuffling: vi.fn(() => Promise.resolve(true)),
  submitDefinition: vi.fn(() => Promise.resolve()),
  applyWritingTimeoutOrAdvance: vi.fn(() => Promise.resolve()),
  DuplicateDefinitionError: class extends Error {},
}));
vi.mock("@/lib/room", () => room);
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn(() => new Promise(() => {})) },
    rpc: () => new Promise(() => {}),
  },
}));
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

const ROOM = {
  id: "r1",
  code: "1234",
  status: "writing",
  current_round: 2,
  current_coordinator: "p_coord",
  current_word_id: "w1",
  round_phase_ends_at: new Date(Date.now() + 60_000).toISOString(),
} as unknown as Room;
const person = (id: string, is_bot = false) =>
  ({
    id,
    nickname: id,
    avatar: "🙂",
    color: "#f0f",
    is_bot,
  }) as unknown as Player;
const ME = person("p_me");
const COORD = person("p_coord");
const WORD = { id: "w1", word: "rapape" } as Word;
const roomOf = (n: number) => [
  ME,
  COORD,
  ...Array.from({ length: n - 2 }, (_, i) => person(`bot_${i}`, true)),
];
const ext = (attempt: number): RoundExtension => ({
  id: `e${attempt}`,
  room_id: "r1",
  round: 2,
  player_id: "p_me",
  attempt,
  applied_at: "",
  phase: "writing",
});

const timerMax = (
  players: Player[],
  roundExtensions: RoundExtension[] = [],
) => {
  const { container } = render(
    <WriteDefinition
      room={ROOM}
      players={players}
      word={WORD}
      me={ME}
      isCoordinator={false}
      definitions={[]}
      roundExtensions={roundExtensions}
      isHost={false}
      isDeputy={false}
    />,
  );
  const max = container.querySelector("[data-max]")?.getAttribute("data-max");
  cleanup();
  return Number(max);
};

afterEach(() => cleanup());

describe("escrita: a barra NÃO cresce com o nº de jogadores", () => {
  it("70 s (base 60 + 10) com 4, 6, 8, 10 e 12 jogadores", () => {
    const byN = [4, 6, 8, 10, 12].map((n) => timerMax(roomOf(n)));
    expect(byN).toEqual([70, 70, 70, 70, 70]);
  });

  it("prorrogação fixa: 20 s e depois 15 s, também com 12 jogadores", () => {
    expect(timerMax(roomOf(4), [ext(1)])).toBe(20);
    expect(timerMax(roomOf(12), [ext(1)])).toBe(20);
    expect(timerMax(roomOf(12), [ext(1), ext(2)])).toBe(15);
  });
});
