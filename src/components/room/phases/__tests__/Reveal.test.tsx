import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Definition, Player, Room, Vote, Word } from "@/lib/room";

// Revelação "verdade primeiro" com relógio controlado (fake timers).
const advance = vi.fn(() => Promise.resolve());
const rpc = vi.fn(async () => ({ data: { near_truth_ids: [] as string[] } }));
const sound = vi.hoisted(() => {
  const names = [
    "hapticBigWin",
    "hapticFail",
    "hapticSuccess",
    "playCorrectReveal",
    "playCrowdReactionFooled",
    "playCrowdReactionNoOne",
    "playFooled",
    "playFooledOthersMagnitude",
    "playImpact",
    "playPerfectRound",
    "playPointGained",
    "playSavage",
    "playTailFreeze",
    "playUITap",
  ];
  return Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<
    string,
    ReturnType<typeof vi.fn>
  >;
});
vi.mock("@/lib/sound", () => sound);
vi.mock("@/lib/room", () => ({
  advanceAfterReveal: (...a: unknown[]) => advance(...(a as [])),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
vi.mock("@/lib/player-id", () => ({ getPlayerId: () => "p_me" }));
vi.mock("@/components/RevealFx", () => ({ RevealFx: () => null }));
vi.mock("@/components/room/shared", () => ({
  WordCard: ({ word }: { word: Word }) => <div>palavra: {word.word}</div>,
}));

import { Reveal } from "../Reveal";

const room = { id: "r1", code: "1234", current_round: 3 } as Room;
const word = {
  id: "w1",
  word: "zarabatana",
  meaning: "tubo de soprar dardos",
  category: null,
  rarity: 1,
} as Word;
const P = (id: string, nickname: string): Player =>
  ({
    id,
    nickname,
    avatar: "🙂",
    room_id: "r1",
    color: "#000",
    score: 0,
    is_bot: false,
    is_connected: true,
    coordinator_count: 0,
    joined_at: "",
  }) as Player;
const D = (
  id: string,
  player_id: string,
  letter: string | null,
  text: string,
): Definition =>
  ({ id, room_id: "r1", round: 3, player_id, letter, text }) as Definition;
const V = (voter_id: string, definition_id: string): Vote =>
  ({
    id: `${voter_id}-${definition_id}`,
    room_id: "r1",
    round: 3,
    voter_id,
    definition_id,
  }) as Vote;

// Ana acerta; Bia (eu) cai no blefe da Ana; Beto e Caio caem no MEU blefe.
const players = [
  P("p_me", "Bia"),
  P("p_ana", "Ana"),
  P("p_beto", "Beto"),
  P("p_caio", "Caio"),
];
const definitions = [
  D("T", "__truth__", "E", "tubo de soprar dardos"),
  D("dA", "p_ana", "A", "dança de roda"),
  D("dB", "p_beto", "B", "fruta azeda"),
  D("dC", "p_me", "C", "canoa indígena"),
  D("dD", "p_caio", "D", "chapéu de couro"),
];
const votes = [
  V("p_ana", "T"),
  V("p_me", "dA"),
  V("p_beto", "dC"),
  V("p_caio", "dC"),
];

// Avança o relógio em passos curtos (um act por passo): como no navegador,
// cada passo da coreografia renderiza — e soa — antes do próximo.
const tick = async (ms: number) => {
  for (let t = 0; t < ms; t += 50) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(50, ms - t));
    });
  }
};
// consultas só na região visual (a região do leitor de tela repete o texto)
const region = () =>
  screen.getByRole("region", { name: "Revelação da rodada" });
const shown = (t: string) => within(region()).queryByText(t, { exact: false });
const bluffOrderOnScreen = () =>
  ["dança de roda", "fruta azeda", "canoa indígena", "chapéu de couro"].filter(
    (t) => shown(t),
  );
const mount = (
  over: Partial<{
    isHost: boolean;
    votes: Vote[];
    definitions: Definition[];
    players: Player[];
  }> = {},
) =>
  render(
    <Reveal
      room={room}
      word={word}
      players={over.players ?? players}
      definitions={over.definitions ?? definitions}
      votes={over.votes ?? votes}
      isHost={over.isHost ?? true}
    />,
  );

beforeEach(() => {
  vi.useFakeTimers();
  advance.mockClear();
  rpc.mockClear();
  for (const f of Object.values(sound)) f.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("verdade primeiro", () => {
  it("a verdade aparece em ~0,5 s, antes de qualquer blefe", async () => {
    mount();
    expect(shown("Revelação")).toBeTruthy();
    expect(
      within(region()).queryByText("A definição verdadeira", { exact: false }),
    ).toBeNull();
    await tick(600);
    expect(
      within(region()).getByText("A definição verdadeira", { exact: false }),
    ).toBeTruthy();
    expect(bluffOrderOnScreen()).toEqual([]);
    expect(sound.playImpact).toHaveBeenCalledTimes(1);
  });

  it("depois: quem acertou (com os pontos de sempre)", async () => {
    mount();
    await tick(1600);
    expect(shown("Só um acertou")).toBeTruthy();
    const ana = within(region()).getByText("Ana").closest("li")!;
    expect(ana.textContent).toContain("+4"); // +3 do acerto +1 voto no blefe dela
    expect(bluffOrderOnScreen()).toEqual([]);
  });

  it("blefes um a um: do que passou batido ao que mais enganou; todos aparecem", async () => {
    mount();
    await tick(3050); // ponte + 1º blefe
    expect(shown("quem enganou quem")).toBeTruthy();
    expect(bluffOrderOnScreen()).toEqual(["fruta azeda"]);
    await tick(550);
    expect(bluffOrderOnScreen().sort()).toEqual([
      "chapéu de couro",
      "fruta azeda",
    ]);
    await tick(10_000);
    expect(bluffOrderOnScreen().sort()).toEqual(
      [
        "canoa indígena",
        "chapéu de couro",
        "dança de roda",
        "fruta azeda",
      ].sort(),
    );
    // ordem final na tela: o mais votado no topo (último revelado)
    const items = within(region())
      .getAllByRole("listitem")
      .filter((li) => li.className.includes("sticker"));
    expect(items[0]!.textContent).toContain("canoa indígena");
  });

  it("blefe da rodada = o mais votado, com o meu destaque pessoal", async () => {
    mount();
    await tick(12_000);
    const best = within(region())
      .getByText("🏆 Blefe da rodada")
      .closest("li")!;
    expect(best.textContent).toContain("canoa indígena");
    expect(best.textContent).toContain("seu blefe");
    expect(best.textContent).toContain("+2 pts");
    // eu caí no blefe da Ana: meu avatar aparece como "você" na lista de quem caiu
    const ana = within(region())
      .getByText("dança de roda", { exact: false })
      .closest("li")!;
    expect(ana.textContent).toContain("você");
  });

  it("som por passo: meu blefe enganou → recompensa; caí → reação leve", async () => {
    mount();
    await tick(12_000);
    expect(sound.playFooledOthersMagnitude).toHaveBeenCalledWith(2);
    expect(sound.playFooled).toHaveBeenCalledTimes(1);
    expect(sound.hapticFail).toHaveBeenCalledTimes(1);
    expect(sound.hapticBigWin).toHaveBeenCalledTimes(1); // blefe da rodada é meu
    expect(sound.playCrowdReactionFooled).not.toHaveBeenCalled();
    expect(sound.playImpact).toHaveBeenCalledTimes(1);
  });

  it("🧠 'Chegou perto da verdade +3 pts' no blefe que o juiz marcou — só nele", async () => {
    rpc.mockResolvedValue({ data: { near_truth_ids: ["dB"] } });
    mount();
    await tick(12_000);
    const tags = region().querySelectorAll('[data-near-truth="1"]');
    expect(tags).toHaveLength(1);
    const tag = tags[0]!;
    expect(tag.textContent).toBe("🧠 Chegou perto da verdade+3 pts");
    // no card do blefe do Beto ("fruta azeda"), não na verdade nem em quem
    // acertou (Ana só leva o +3 do acerto, sem o selo de proximidade)
    expect(tag.closest("li")!.textContent).toContain("fruta azeda");
    expect(tag.closest(".truth-card")).toBeNull();
    const ana = within(region()).getByText("Ana").closest("li")!;
    expect(ana.querySelector('[data-near-truth="1"]')).toBeNull();
    // o valor fica junto (unidade que não quebra)
    expect(tag.querySelector(".whitespace-nowrap")!.textContent).toBe("+3 pts");
    rpc.mockResolvedValue({ data: { near_truth_ids: [] } });
  });

  it("card da verdade mostra a letra da cédula verdadeira (definitions.letter)", async () => {
    mount();
    await tick(600);
    const card = region().querySelector(".truth-card")!;
    const letter = card.querySelector("[data-truth-letter]")!;
    // a mesma letra que a cédula da verdade teve na votação ("E" no banco),
    // não a posição na tela
    expect(letter.textContent).toBe("E");
    expect(letter.getAttribute("aria-label")).toBe("Alternativa E");
    expect(card.textContent).toContain("✓ Verdade");
  });

  it("sem letra (dados antigos): o card da verdade não mostra um quadrado vazio", async () => {
    mount({
      definitions: definitions.map((d) =>
        d.player_id === "__truth__" ? { ...d, letter: null } : d,
      ),
    });
    await tick(600);
    const card = region().querySelector(".truth-card")!;
    expect(card.querySelector("[data-truth-letter]")).toBeNull();
    expect(card.textContent).toContain("✓ Verdade");
  });
});

describe("casos de rodada", () => {
  it("ninguém acertou: momento de humor + linha do coordenador", async () => {
    mount({
      votes: [
        V("p_ana", "dB"),
        V("p_me", "dA"),
        V("p_beto", "dC"),
        V("p_caio", "dC"),
      ],
    });
    await tick(1600);
    expect(shown("Ninguém acertou")).toBeTruthy();
    expect(shown("o coordenador leva +2")).toBeTruthy();
    expect(sound.playCrowdReactionNoOne).toHaveBeenCalledTimes(1);
  });

  it("todos os blefes com zero voto: não existe blefe da rodada", async () => {
    mount({
      votes: [
        V("p_ana", "T"),
        V("p_me", "T"),
        V("p_beto", "T"),
        V("p_caio", "T"),
      ],
    });
    await tick(15_000);
    expect(within(region()).queryByText("🏆 Blefe da rodada")).toBeNull();
    expect(shown("Todo mundo acertou")).toBeTruthy();
  });

  it("sala cheia (12 jogadores, 11 blefes): tudo revelado em menos de 15 s", async () => {
    const many = Array.from({ length: 12 }, (_, i) => P(`p${i}`, `J${i}`));
    const defs = [
      D("T", "__truth__", null, "verdade"),
      ...many
        .slice(1)
        .map((p, i) =>
          D(
            `d${i}`,
            p.id,
            String.fromCharCode(65 + i),
            `blefe-${String(i).padStart(2, "0")}`,
          ),
        ),
    ];
    const vs = many.map((p, i) =>
      V(p.id, i % 3 === 0 ? "T" : `d${(i + 1) % 11}`),
    );
    mount({ players: many, definitions: defs, votes: vs });
    await tick(15_000);
    for (let i = 0; i < 11; i++)
      expect(shown(`blefe-${String(i).padStart(2, "0")}`)).toBeTruthy();
    expect(screen.queryByText("📊 Placar em")).toBeTruthy();
  });

  it("sala mínima (2 jogadores, 1 blefe)", async () => {
    const two = [P("p_me", "Bia"), P("p_ana", "Ana")];
    mount({
      players: two,
      definitions: [
        D("T", "__truth__", "B", "verdade"),
        D("dA", "p_ana", "A", "dança de roda"),
      ],
      votes: [V("p_me", "dA")],
    });
    await tick(6_000);
    expect(shown("dança de roda")).toBeTruthy();
    expect(screen.queryByText("📊 Placar em")).toBeTruthy();
  });

  it("host e convidado veem a mesma sequência", async () => {
    const a = mount({ isHost: true });
    await tick(4_200);
    const hostSeq = bluffOrderOnScreen();
    a.unmount();
    mount({ isHost: false });
    await tick(4_200);
    expect(bluffOrderOnScreen()).toEqual(hostSeq);
  });
});

describe("topo compacto, sem compartilhar (playtest 2026-10-20)", () => {
  it("nenhum compartilhamento durante a partida — nem da rodada, nem do resultado", async () => {
    mount();
    await tick(12_000); // fim da coreografia
    expect(screen.queryByText(/Compartilhar/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Compartilhar/ })).toBeNull();
  });

  it("o Avançar agora do host fica no topo, fora da rolagem, junto da contagem", async () => {
    mount();
    await tick(12_000);
    const btn = screen.getByText("⏭ Avançar agora");
    expect(region().contains(btn)).toBe(false);
    expect(btn.compareDocumentPosition(region())).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // a contagem mora na mesma linha
    expect(btn.parentElement!.textContent).toContain("Placar em");
  });

  it("convidado: sem Avançar; a linha do topo só aparece com a contagem", async () => {
    mount({ isHost: false });
    await tick(3_000);
    expect(screen.queryByText("📊 Placar em")).toBeNull();
    expect(screen.queryByText("⏭ Avançar agora")).toBeNull();
  });
});

describe("contagem e avanço", () => {
  it("a contagem só começa depois dos blefes; o host avança sozinho uma vez", async () => {
    mount();
    await tick(5_000);
    expect(screen.queryByText("📊 Placar em")).toBeNull();
    await tick(7_000); // fim da coreografia
    expect(screen.queryByText("📊 Placar em")).toBeTruthy();
    await tick(9_000); // 8 s de leitura (4 jogadores)
    expect(advance).toHaveBeenCalledTimes(1);
    await tick(10_000);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("convidado nunca dispara o avanço", async () => {
    mount({ isHost: false });
    await tick(30_000);
    expect(advance).not.toHaveBeenCalled();
    expect(screen.queryByText("⏭ Avançar agora")).toBeNull();
  });

  it("'Avançar agora' no meio da sequência: avança uma vez, cancela o resto e não toca mais nada", async () => {
    mount();
    await tick(1_000);
    const btn = screen.getByText("⏭ Avançar agora");
    fireEvent.click(btn);
    fireEvent.click(screen.getByText("Indo pro placar…"));
    for (const f of Object.values(sound)) f.mockClear();
    await tick(1_200);
    expect(advance).toHaveBeenCalledTimes(1);
    await tick(30_000);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(sound.playImpact).not.toHaveBeenCalled();
    expect(sound.playFooled).not.toHaveBeenCalled();
    expect(sound.playTailFreeze).not.toHaveBeenCalled();
  });

  it("saiu da tela no meio (servidor já foi pro placar): nenhum avanço nem som atrasado", async () => {
    const r = mount();
    await tick(2_000);
    fireEvent.click(screen.getByText("⏭ Avançar agora"));
    r.unmount();
    for (const f of Object.values(sound)) f.mockClear();
    await tick(30_000);
    expect(advance).not.toHaveBeenCalled();
    expect(Object.values(sound).every((f) => f.mock.calls.length === 0)).toBe(
      true,
    );
  });

  it("nenhuma chamada de pontuação: só a consulta do 🧠 e o avanço", async () => {
    mount();
    await tick(25_000);
    expect(
      rpc.mock.calls.every((c) => (c as unknown[])[0] === "get_room_reveal"),
    ).toBe(true);
    expect(advance).toHaveBeenCalledTimes(1);
  });
});

// Regressão 2.1.1 (teste real no Android): a troca votação → revelação chega
// antes do shape da revelação. Na votação o servidor manda as cédulas SEM
// autor (player_id "") e sem a marca da verdadeira (get_round_sync,
// fase1_ballot_secure); em rede lenta a coreografia começava com elas — a
// verdade aparecia vazia, a verdadeira ia para a lista de blefes e o
// significado só surgia depois dos blefes.
describe("dados da revelação atrasados (rede lenta / celular)", () => {
  const ballots = definitions.map((d) => ({ ...d, player_id: "" }));
  const hiddenWord = { ...word, meaning: undefined } as Word;
  const view = (defs: Definition[], w: Word) => (
    <Reveal
      room={room}
      word={w}
      players={players}
      definitions={defs}
      votes={votes}
      isHost
    />
  );

  it("com as cédulas anônimas da votação: nada revelado (nem verdade vazia, nem blefes)", async () => {
    render(view(ballots, hiddenWord));
    await tick(4_000);
    expect(shown("Revelação")).toBeTruthy();
    expect(
      within(region()).queryByText("A definição verdadeira", { exact: false }),
    ).toBeNull();
    expect(
      within(region()).queryByRole("list", { name: "Blefes da rodada" }),
    ).toBeNull();
    expect(sound.playImpact).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it("quando os dados chegam (mesmo tarde): VERDADE primeiro, blefes só depois, e a verdadeira nunca vira blefe", async () => {
    const r = render(view(ballots, hiddenWord));
    await tick(4_000);
    r.rerender(view(definitions, word));
    await tick(600);
    expect(
      within(region()).getByText("A definição verdadeira", { exact: false }),
    ).toBeTruthy();
    expect(shown("tubo de soprar dardos")).toBeTruthy();
    expect(bluffOrderOnScreen()).toEqual([]);
    await tick(2_500);
    expect(bluffOrderOnScreen()).toEqual(["fruta azeda"]);
    await tick(10_000);
    const list = within(region()).getByRole("list", {
      name: "Blefes da rodada",
    });
    // só os cartões (itens diretos); dentro deles há listas de votantes
    expect(list.querySelectorAll(":scope > li")).toHaveLength(4);
    expect(
      within(list).queryByText("tubo de soprar dardos", { exact: false }),
    ).toBeNull();
  });

  it("autores conhecidos mas sem verdade nem significado ainda: espera o significado", async () => {
    const noTruth = definitions.filter((d) => d.player_id !== "__truth__");
    const r = render(view(noTruth, hiddenWord));
    await tick(3_000);
    expect(
      within(region()).queryByText("A definição verdadeira", { exact: false }),
    ).toBeNull();
    r.rerender(view(noTruth, word));
    await tick(600);
    expect(shown("tubo de soprar dardos")).toBeTruthy();
  });
});
