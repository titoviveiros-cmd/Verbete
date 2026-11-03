import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Onboarding } from "@/components/Onboarding";
import { GameTip } from "@/components/GameTip";

vi.mock("@/lib/player-id", () => ({
  getStored: () => "",
  setStored: vi.fn(),
}));

afterEach(cleanup);

describe("Como jogar: quatro telas e votação interativa", () => {
  it("explica a palavra e a escrita sem piadas extras", async () => {
    render(<Onboarding onClose={() => {}} />);
    expect(
      screen.getByRole("heading", { name: "Escolha a palavra" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/o significado verdadeiro fica escondido/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Próximo/ }));
    expect(
      await screen.findByRole("heading", { name: "Invente um significado" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/sem mostrar quem escreveu cada uma/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Spoiler|aprendizado emocional|portuguesinho/i),
    ).not.toBeInTheDocument();
  });

  it("preserva o voto correto e a pontuação explicada", async () => {
    render(<Onboarding onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Passo 3" }));
    expect(
      await screen.findByRole("heading", { name: "Hora de votar" }),
    ).toBeInTheDocument();
    expect(screen.getByText("borogodó")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Charme natural/ }));
    expect(
      screen.getByText("Acertou! Na partida, isso vale 3 pontos."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(
      await screen.findByRole("heading", { name: "Como ganhar pontos" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\+3 pontos por votar na definição verdadeira/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\+1 ponto por voto recebido no seu blefe/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Vamos jogar!" }),
    ).toBeInTheDocument();
  });

  it("ao errar, indica a resposta correta sem mudar a alternativa", async () => {
    render(<Onboarding onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Passo 3" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Instrumento de sopro/ }),
    );
    expect(screen.getByText(/Não foi dessa vez!/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Charme natural/ }),
    ).toBeDisabled();
  });

  it("bolinhas de etapa: inativas com contraste do tema e destaque acompanha a etapa", () => {
    render(<Onboarding onClose={() => {}} />);
    const dot = (n: number) =>
      screen.getByRole("button", { name: `Passo ${n}` });
    expect(dot(1)).toHaveClass("w-7", "bg-pink");
    for (const n of [2, 3, 4]) {
      expect(dot(n)).toHaveClass("bg-foreground/45");
      expect(dot(n)).not.toHaveClass("bg-white/20", "bg-pink");
    }
    fireEvent.click(dot(2));
    expect(dot(2)).toHaveClass("w-7", "bg-pink");
    expect(dot(2)).not.toHaveClass("bg-foreground/45");
    expect(dot(1)).toHaveClass("bg-foreground/45");
    expect(dot(1)).not.toHaveClass("bg-pink");
  });
});

describe("Dicas da primeira rodada", () => {
  const phases = [
    ["lobby", "Convide os amigos", /pelo menos 4 participantes/],
    ["choosing", "Escolha da palavra", /três palavras sorteadas/],
    ["writing", "Crie sua definição", /antes que o tempo acabe/],
    ["voting", "Hora de votar", /cada voto no seu blefe vale 1/],
    ["reveal", "Hora da verdade", /quem conseguiu enganar os outros/],
  ] as const;

  for (const [phase, title, body] of phases) {
    it(`apresenta a dica de ${phase}`, () => {
      render(<GameTip phase={phase} round={1} />);
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(body)).toBeInTheDocument();
    });
  }

  it("não exibe dicas a partir da segunda rodada", () => {
    render(<GameTip phase="voting" round={2} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Integridade da redação", () => {
  it("não contém campo de piadas nem travessões nos dois componentes", () => {
    for (const name of ["Onboarding.tsx", "GameTip.tsx"]) {
      const text = readFileSync(resolve("src/components", name), "utf8");
      expect(text).not.toContain("—");
      expect(text).not.toContain("–");
      expect(text).not.toContain("joke:");
      expect(text).not.toContain("step.joke");
    }
  });
});
