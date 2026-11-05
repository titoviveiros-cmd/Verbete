import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Definition, Player, Room, Word } from "@/lib/room";

// "Enviar definição" (05/11/2026): o dono percebia 5–7 s até o jogo "aceitar
// o envio ou avançar". Medição em tempo VIRTUAL (temporizadores falsos), com
// cada ida e volta ao Supabase simulada em RTT_MS — a mediana medida da
// máquina do dono até o projeto (keep-alive: p50 247 ms, p90 279 ms).
// Cobre: (1) feedback imediato ao clique, (2) "enviada ✓" só DEPOIS da
// confirmação do servidor, (3) envio duplo, (4) do "todos enviaram" até o
// pedido de embaralhamento no host.
const RTT_MS = 250;

const room = vi.hoisted(() => ({
  botSubmitDefinitions: vi.fn(),
  BOT_AI_GRACE_MS: 6000,
  generateAiDefinitionForPlayer: vi.fn(() => new Promise(() => {})),
  startShuffling: vi.fn(() => Promise.resolve(true)),
  submitDefinition: vi.fn(),
  applyWritingTimeoutOrAdvance: vi.fn(() => Promise.resolve()),
  DuplicateDefinitionError: class extends Error {},
  DefinitionRejectedError: class extends Error {},
}));
vi.mock("@/lib/room", () => room);
const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: () => new Promise(() => {}) },
    rpc: (...a: unknown[]) => rpc.fn(...a),
  },
}));
vi.mock("@/hooks/use-terms-gate", () => ({
  useTermsGate: () => ({
    needed: false,
    checked: true,
    setChecked: () => {},
    error: false,
    inputRef: { current: null },
    confirm: () => true,
  }),
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
import { resetAutoDefinitions } from "@/lib/auto-definition";

const ROOM = {
  id: "r1",
  code: "1234",
  status: "writing",
  current_round: 4,
  current_coordinator: "p_coord",
  current_word_id: "w1",
} as unknown as Room;
const mk = (id: string, nickname: string, is_bot = false) =>
  ({ id, nickname, avatar: "🦊", color: "#f0f", is_bot }) as unknown as Player;
const ME = mk("p_me", "Bia");
const OTHER = mk("p_ana", "Ana");
const COORD = mk("p_coord", "Rui");
const WORD = { id: "w1", word: "rapape" } as Word;
const def = (player_id: string) =>
  ({ id: `d_${player_id}`, player_id, round: 4 }) as unknown as Definition;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 4; i++) {
      await vi.dynamicImportSettled();
      for (let j = 0; j < 5; j++) await Promise.resolve();
    }
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
};
const props = (over: Record<string, unknown> = {}) => ({
  room: ROOM,
  players: [ME, OTHER, COORD],
  word: WORD,
  me: ME,
  isCoordinator: false,
  definitions: [] as Definition[],
  roundExtensions: [],
  isHost: false,
  isDeputy: false,
  ...over,
});
const field = () =>
  screen.getByPlaceholderText(
    "escreva sua definicao mirabolante...",
  ) as HTMLTextAreaElement;
const body = () => document.body.textContent ?? "";
const metrics: Record<string, unknown> = {};

beforeEach(() => {
  vi.useFakeTimers();
  resetAutoDefinitions();
  room.submitDefinition.mockReset();
  room.startShuffling.mockClear();
  room.submitDefinition.mockImplementation(
    () => new Promise<void>((r) => setTimeout(r, RTT_MS)),
  );
  rpc.fn.mockReset();
  rpc.fn.mockImplementation(
    (name: string) =>
      new Promise((r) =>
        setTimeout(
          () =>
            r(
              name === "get_round_sync"
                ? { data: { definitions: [def("p_me"), def("p_ana")] } }
                : { data: null },
            ),
          RTT_MS,
        ),
      ),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  console.log(`[medicao] ${JSON.stringify(metrics)}`);
});

describe("Enviar definição — feedback, confirmação e avanço (tempo virtual)", () => {
  it("feedback em ≤ 200 ms e 'enviada ✓' só depois da confirmação do servidor", async () => {
    render(<WriteDefinition {...props()} />);
    await flush();
    fireEvent.change(field(), { target: { value: "um tipo de dança" } });
    fireEvent.click(
      screen.getAllByRole("button", { name: /Enviar definição/ })[0]!,
    );
    await flush();
    // t = 0 (RPC ainda em voo)
    metrics.feedbackEmT0 = /Enviando|Definição enviada/.test(body());
    metrics.sucessoAntesDaConfirmacao = /Definição enviada/.test(body());
    expect(metrics.feedbackEmT0).toBe(true);
    expect(metrics.sucessoAntesDaConfirmacao).toBe(false);
    await advance(RTT_MS);
    metrics.sucessoAposConfirmacao = /Definição enviada/.test(body());
    expect(metrics.sucessoAposConfirmacao).toBe(true);
  });

  it("erro do servidor: volta ao campo com o texto, sem ter mostrado sucesso", async () => {
    room.submitDefinition.mockImplementation(
      () =>
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error("rede")), RTT_MS),
        ),
    );
    render(<WriteDefinition {...props()} />);
    await flush();
    fireEvent.change(field(), { target: { value: "um tipo de dança" } });
    fireEvent.click(
      screen.getAllByRole("button", { name: /Enviar definição/ })[0]!,
    );
    await flush();
    expect(/Definição enviada/.test(body())).toBe(false);
    await advance(RTT_MS);
    expect(field().value).toBe("um tipo de dança");
    expect(/Definição enviada/.test(body())).toBe(false);
  });

  it("dois Enter no mesmo instante = UM envio", async () => {
    render(<WriteDefinition {...props()} />);
    await flush();
    const f = field();
    fireEvent.change(f, { target: { value: "um tipo de dança" } });
    await act(async () => {
      f.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      f.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flush();
    metrics.enviosNoDuploEnter = room.submitDefinition.mock.calls.length;
    expect(metrics.enviosNoDuploEnter).toBe(1);
  });

  it("host: do 'todos enviaram' ao pedido de embaralhamento = 600 ms + 1 RTT (cadeia intencional preservada)", async () => {
    const view = render(
      <WriteDefinition
        {...props({ isHost: true, definitions: [def("p_me")] })}
      />,
    );
    await flush();
    await advance(10_000); // passa o piso da cortina + tela mínima
    expect(room.startShuffling).not.toHaveBeenCalled();
    const t0 = Date.now();
    view.rerender(
      <WriteDefinition
        {...props({ isHost: true, definitions: [def("p_me"), def("p_ana")] })}
      />,
    );
    await flush();
    let waited = 0;
    while (!room.startShuffling.mock.calls.length && waited < 5000) {
      await advance(25);
      waited += 25;
    }
    metrics.hostTodosEnviaramAteEmbaralharMs = Date.now() - t0;
    expect(room.startShuffling).toHaveBeenCalledTimes(1);
    // Cadeia INTENCIONAL preservada: piso de 600 ms + recontagem no banco
    // (1 ida e volta). Antecipar a recontagem para dentro do piso foi
    // REJEITADO: a definição do próprio host ainda pendente não seria
    // contada e a mesa travaria até o fim do tempo (o efeito não reexecuta).
    expect(metrics.hostTodosEnviaramAteEmbaralharMs).toBe(600 + RTT_MS);
  }, 60_000);

  it("host com a PRÓPRIA definição ainda pendente: mostra 'Enviando…' e a mesa avança normalmente", async () => {
    const pendingMine = {
      id: "pending_p_me_4",
      player_id: "p_me",
      round: 4,
    } as unknown as Definition;
    const view = render(
      <WriteDefinition
        {...props({ isHost: true, definitions: [def("p_ana")] })}
      />,
    );
    await flush();
    await advance(10_000);
    view.rerender(
      <WriteDefinition
        {...props({ isHost: true, definitions: [def("p_ana"), pendingMine] })}
      />,
    );
    await flush();
    expect(/Enviando sua definição/.test(body())).toBe(true);
    expect(/Definição enviada/.test(body())).toBe(false);
    await advance(600 + RTT_MS + 50);
    expect(room.startShuffling).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("só faltam bots: o painel diz isso (sem prometer o avanço)", async () => {
    const BOT = mk("p_bot", "Robô", true);
    render(
      <WriteDefinition
        {...props({
          players: [ME, OTHER, BOT, COORD],
          definitions: [def("p_me"), def("p_ana")],
        })}
      />,
    );
    await flush();
    expect(/Definição enviada! ✓/.test(body())).toBe(true);
    expect(/Só faltam os bots/.test(body())).toBe(true);
  });

  it("host: recontagem com alguém faltando NÃO embaralha (proteção preservada)", async () => {
    rpc.fn.mockImplementation(
      (name: string) =>
        new Promise((r) =>
          setTimeout(
            () =>
              r(
                name === "get_round_sync"
                  ? { data: { definitions: [def("p_me")] } }
                  : { data: null },
              ),
            RTT_MS,
          ),
        ),
    );
    const view = render(
      <WriteDefinition
        {...props({ isHost: true, definitions: [def("p_me")] })}
      />,
    );
    await flush();
    await advance(10_000);
    view.rerender(
      <WriteDefinition
        {...props({ isHost: true, definitions: [def("p_me"), def("p_ana")] })}
      />,
    );
    await flush();
    await advance(3000);
    expect(room.startShuffling).not.toHaveBeenCalled();
  });
});
