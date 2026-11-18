// Conquistas consultáveis (18/11/2026): toque, mouse e teclado abrem o "como
// desbloquear" de QUALQUER conquista (inclusive bloqueada), um cartão por vez,
// com nome completo, estado e a descrição do catálogo — e consultar não chama o
// servidor nem mexe em nada.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  ACHIEVEMENT_GOT,
  ACHIEVEMENT_HINT,
  ACHIEVEMENT_LOCKED,
  AchievementGrid,
} from "@/components/AchievementGrid";
import type { Achievement } from "@/lib/daily";

beforeAll(() => {
  // jsdom não tem ResizeObserver (o posicionamento do Radix usa)
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// as descrições REAIS do catálogo (produção = migrations, conferido 18/11)
const CATALOGO: Achievement[] = [
  {
    code: "first_win",
    name: "Primeira Vitória",
    description: "Vença sua primeira partida.",
    emoji: "🥇",
    rarity: "common",
  },
  {
    code: "maior_enganador",
    name: "Maior Enganador",
    description: "Engane 5 ou mais jogadores numa única partida.",
    emoji: "🦊",
    rarity: "rare",
  },
  {
    code: "acertos_100",
    name: "Mestre das Palavras",
    description: "Acerte a definição verdadeira 100 vezes.",
    emoji: "🧠",
    rarity: "epic",
  },
];

let unlocked: Set<string>;
const fetchSpy = vi.fn();

beforeEach(() => {
  unlocked = new Set(["first_win"]);
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const renderGrid = () =>
  render(<AchievementGrid achievements={CATALOGO} unlocked={unlocked} />);
const btn = (code: string) => screen.getByTestId(`conquista-${code}`);
const cartoes = () => screen.queryAllByRole("dialog");
// exatamente um cartão aberto (falha se houver zero ou mais de um)
const cartao = () => screen.getByRole("dialog");
// toque/clique = pointerdown (fora do mouse) + click, como o navegador faz
const tocar = (el: Element) => {
  fireEvent.pointerDown(el, { pointerType: "touch" });
  fireEvent.click(el);
};

describe("AchievementGrid", () => {
  it("mostra a orientação e um botão acessível por conquista, sem cartão aberto", () => {
    renderGrid();
    expect(screen.getByText(ACHIEVEMENT_HINT)).toBeInTheDocument();
    expect(ACHIEVEMENT_HINT).toBe(
      "Toque em uma conquista para saber como desbloqueá-la.",
    );
    for (const a of CATALOGO) {
      expect(btn(a.code).tagName).toBe("BUTTON");
      expect(btn(a.code)).toHaveAccessibleName(
        `${a.name}: ${(unlocked.has(a.code) ? ACHIEVEMENT_GOT : ACHIEVEMENT_LOCKED).toLowerCase()}`,
      );
    }
    expect(cartoes()).toHaveLength(0);
  });

  it("um toque numa conquista BLOQUEADA abre o cartão legível com nome completo, estado e condição", () => {
    renderGrid();
    tocar(btn("maior_enganador"));
    const c = cartao();
    expect(c).toHaveAccessibleName("Maior Enganador");
    expect(c).toHaveTextContent("Maior Enganador");
    expect(c).toHaveTextContent(ACHIEVEMENT_LOCKED);
    expect(c).toHaveTextContent(
      "Engane 5 ou mais jogadores numa única partida.",
    );
    // o cartão NÃO está dentro do ícone esmaecido (portal): não herda opacity-30/grayscale
    expect(btn("maior_enganador").querySelector(".opacity-30")).not.toBeNull();
    // o botão em si não fica transparente (contorno de foco visível)
    expect(btn("maior_enganador").className).not.toMatch(/opacity-|grayscale/);
    expect(btn("maior_enganador").contains(c)).toBe(false);
    expect(c.closest(".opacity-30")).toBeNull();
    expect(c.closest(".grayscale")).toBeNull();
  });

  it("conquista já obtida mostra 'Conquistada'", () => {
    renderGrid();
    tocar(btn("first_win"));
    expect(cartao()).toHaveTextContent(ACHIEVEMENT_GOT);
    expect(cartao()).not.toHaveTextContent(ACHIEVEMENT_LOCKED);
  });

  it("só um cartão por vez: tocar em outra troca; tocar na mesma fecha", () => {
    renderGrid();
    tocar(btn("first_win"));
    tocar(btn("acertos_100"));
    expect(cartoes()).toHaveLength(1);
    expect(cartao()).toHaveAccessibleName("Mestre das Palavras");
    tocar(btn("acertos_100"));
    expect(cartoes()).toHaveLength(0);
  });

  it("fecha com Escape, com toque fora e com o botão Fechar", async () => {
    // o Radix só registra o "toque fora" um tick depois de abrir
    const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));
    renderGrid();
    tocar(btn("first_win"));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(cartoes()).toHaveLength(0);

    tocar(btn("first_win"));
    await tick();
    // toque fora = pointerdown + click (no toque o Radix fecha no click)
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    fireEvent.click(document.body);
    expect(cartoes()).toHaveLength(0);

    tocar(btn("first_win"));
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(cartoes()).toHaveLength(0);
  });

  it("mouse: passar por cima abre; ir do ícone para o cartão não fecha; sair fecha; clicar fixa", () => {
    vi.useFakeTimers();
    renderGrid();
    fireEvent.pointerEnter(btn("acertos_100"), { pointerType: "mouse" });
    expect(cartoes()).toHaveLength(1);
    // sai do ícone e entra no cartão antes do prazo: continua aberto
    fireEvent.pointerLeave(btn("acertos_100"), { pointerType: "mouse" });
    fireEvent.pointerEnter(cartao(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(1000));
    expect(cartoes()).toHaveLength(1);
    // sai do cartão: fecha
    fireEvent.pointerLeave(cartao(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(1000));
    expect(cartoes()).toHaveLength(0);
    // clique fixa: sair com o mouse não fecha mais
    fireEvent.pointerEnter(btn("acertos_100"), { pointerType: "mouse" });
    fireEvent.pointerDown(btn("acertos_100"), { pointerType: "mouse" });
    fireEvent.click(btn("acertos_100"));
    fireEvent.pointerLeave(btn("acertos_100"), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(1000));
    expect(cartoes()).toHaveLength(1);
  });

  it("teclado: foco abre, Enter fixa/solta, sair do foco fecha o não fixado", () => {
    renderGrid();
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => btn("first_win").focus());
    expect(cartoes()).toHaveLength(1);
    expect(cartao()).toHaveAccessibleName("Primeira Vitória");
    act(() => btn("first_win").blur());
    expect(cartoes()).toHaveLength(0);
    // Enter num botão = click
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => btn("maior_enganador").focus());
    fireEvent.keyDown(btn("maior_enganador"), { key: "Enter" });
    fireEvent.click(btn("maior_enganador"));
    expect(cartoes()).toHaveLength(1);
    fireEvent.keyDown(btn("maior_enganador"), { key: "Enter" });
    fireEvent.click(btn("maior_enganador"));
    expect(cartoes()).toHaveLength(0);
  });

  it("foco por toque/clique não abre sozinho (quem abre é o toque)", () => {
    renderGrid();
    fireEvent.pointerDown(btn("first_win"), { pointerType: "touch" });
    act(() => btn("first_win").focus());
    expect(cartoes()).toHaveLength(0);
  });

  it("consultar não chama o servidor nem altera os desbloqueios", () => {
    const antes = [...unlocked];
    renderGrid();
    for (const a of CATALOGO) {
      tocar(btn(a.code));
      tocar(btn(a.code));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([...unlocked]).toEqual(antes);
  });
});
