// D1 — critérios 1, 2 e 3: a tela do modo escolha não fala em juiz, nota,
// semelhança, % ou IA; mostra só certo/errado + a definição correta; e nenhuma
// requisição de rede sai da tela (as chamadas ao servidor são injetadas).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  ChoiceResultCard,
  DailyChoiceFlow,
  DailyPausePanel,
} from "@/components/daily/DailyChoice";
import {
  CHOICE_HOUR_CHANGED,
  CHOICE_PAUSED,
  type ChoiceResultView,
  type ChoiceStartView,
} from "@/lib/daily-choice";

vi.mock("@/lib/sound", () => ({
  playCountdownTick: vi.fn(),
  playCountdownFinal: vi.fn(),
}));

const PROIBIDO =
  /juiz|\bnota\b|semelhan|%|IA avaliou|intelig[eê]ncia artificial/i;
const OPTIONS = [
  { pos: 0, text: "Pequena embarcação a remo" },
  { pos: 1, text: "Peixe de água doce da Amazônia" },
  { pos: 2, text: "Planta rasteira do litoral" },
  { pos: 3, text: "Dança popular do interior" },
];

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  cleanup();
});

function setup(over: Partial<Parameters<typeof DailyChoiceFlow>[0]> = {}) {
  const start = vi.fn(async (): Promise<ChoiceStartView> => ({
    status: "ok",
    word: "acará",
    category: null,
    options: OPTIONS,
    elapsedS: 0,
    hour: "2026-11-08T16:00:00.000Z",
  }));
  const submit = vi.fn(async (): Promise<ChoiceResultView> => ({
    already_played: false,
    is_correct: true,
    score: 48,
    truth: OPTIONS[1]!.text,
    chosen: OPTIONS[1]!.text,
  }));
  const onFinished = vi.fn();
  const onReload = vi.fn();
  const r = render(
    <DailyChoiceFlow
      start={start}
      submit={submit}
      confirmTerms={() => true}
      onFinished={onFinished}
      onReload={onReload}
      {...over}
    />,
  );
  return { ...r, start, submit, onFinished, onReload };
}

describe("tela do modo escolha", () => {
  it("critério 2: explica 'Escolha a definição correta' e não fala em juiz/nota/semelhança/%/IA", async () => {
    const { container } = setup();
    expect(screen.getByText("Escolha a definição correta")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(PROIBIDO);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(container.textContent).not.toMatch(PROIBIDO);
  });

  it("critério 1: abrir, escolher e confirmar = só as funções do servidor injetadas (0 fetch, 0 IA)", async () => {
    const { start, submit, onFinished } = setup();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    expect(start).toHaveBeenCalledTimes(1);
    const confirmar = screen.getByRole("button", {
      name: /Confirmar resposta/,
    });
    expect(confirmar).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Peixe de água doce/ }));
    expect(
      screen.getByRole("radio", { name: /Peixe de água doce/ }),
    ).toHaveAttribute("aria-checked", "true");
    await act(async () => fireEvent.click(confirmar));
    expect(submit).toHaveBeenCalledWith(1, "2026-11-08T16:00:00.000Z");
    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({ is_correct: true, score: 48 }),
    );
  });

  it("duplo toque em Confirmar = um envio só", async () => {
    let release: (v: ChoiceResultView) => void = () => {};
    const submit = vi.fn(
      () => new Promise<ChoiceResultView>((r) => (release = r)),
    );
    setup({ submit });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    const btn = screen.getByRole("button", { name: /Confirmar resposta/ });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () =>
      release({ already_played: false, is_correct: false, score: 0 }),
    );
  });

  it("sem aceite dos Termos: nada é aberto no servidor", async () => {
    const { start } = setup({ confirmTerms: () => false });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("servidor diz 'já jogou' ou 'outro modo' → recarrega a revisão", async () => {
    const start = vi.fn(async (): Promise<ChoiceStartView> => ({
      status: "mode",
      mode: "juiz",
    }));
    const { onReload } = setup({ start });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    expect(onReload).toHaveBeenCalled();
  });

  it("erro do servidor aparece como alerta, sem tela quebrada", async () => {
    const start = vi.fn(async (): Promise<ChoiceStartView> => {
      throw new Error(CHOICE_PAUSED);
    });
    setup({ start });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/em pausa/);
  });

  it("reabrir na mesma hora continua o relógio do servidor (não zera)", async () => {
    const start = vi.fn(async (): Promise<ChoiceStartView> => ({
      status: "ok",
      word: "acará",
      category: null,
      options: OPTIONS,
      elapsedS: 45,
      hour: "2026-11-08T16:00:00.000Z",
    }));
    const { container } = setup({ start, now: () => 1_000_000 });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    expect(container.querySelector("[data-max]")?.textContent).toMatch(/15/);
  });
});

describe("critério 3 — resultado: só certo/errado e a definição correta", () => {
  it("errou: mostra a escolha e 'Era esta' com a correta; sem nota/medidor/%", () => {
    const { container } = render(
      <ChoiceResultCard
        correct={false}
        score={0}
        truth="Peixe de água doce da Amazônia"
        chosen="Planta rasteira do litoral"
      />,
    );
    expect(screen.getByText("Não foi dessa vez")).toBeInTheDocument();
    expect(screen.getByText(/Era esta/)).toBeInTheDocument();
    expect(screen.getByText(/Peixe de água doce/)).toBeInTheDocument();
    expect(container.querySelector(".meter")).toBeNull();
    expect(container.textContent).not.toMatch(PROIBIDO);
  });
  it("acertou: 'Acertou!' e os pontos", () => {
    const { container } = render(
      <ChoiceResultCard
        correct
        score={47}
        truth="Peixe de água doce da Amazônia"
        chosen="Peixe de água doce da Amazônia"
        streak={3}
      />,
    );
    expect(screen.getByText("Acertou!")).toBeInTheDocument();
    expect(container.textContent).toMatch(/\+47/);
    expect(container.textContent).not.toMatch(PROIBIDO);
  });
  it("pausa: mensagem sem IA", () => {
    const { container } = render(<DailyPausePanel message={CHOICE_PAUSED} />);
    expect(container.textContent).toMatch(/tentativa NÃO foi gasta/);
    expect(container.textContent).not.toMatch(PROIBIDO);
  });
});

describe("Red Team A2 — a tela nunca mistura palavra e alternativas de horas diferentes", () => {
  it("a palavra exibida vem do servidor JUNTO com as alternativas (onStarted)", async () => {
    const onStarted = vi.fn();
    setup({ onStarted });
    expect(onStarted).not.toHaveBeenCalled(); // antes de abrir, a tela não tem a palavra
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    expect(onStarted).toHaveBeenCalledWith({ word: "acará", category: null });
  });

  it("hora virou (ou sessão perdida): volta ao início com o aviso; reabrir traz as da hora nova", async () => {
    const submit = vi.fn(async (): Promise<ChoiceResultView> => {
      throw new Error(CHOICE_HOUR_CHANGED);
    });
    const { start } = setup({ submit });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: /Confirmar resposta/ }),
      ),
    );
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent(/virou de hora/);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Ver alternativas/ })),
    );
    expect(start).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });
});
