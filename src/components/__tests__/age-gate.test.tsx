import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgeGateView } from "@/components/AgeGate";
import { readAgeDeclaration, saveAgeDeclaration } from "@/lib/age";

// ECA Digital B5: selo 13+ no primeiro acesso + ano de nascimento (só no
// aparelho). Páginas de leitura abrem sem a pergunta.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("AgeGate", () => {
  it("primeiro acesso: mostra o selo 13+, pergunta o ano e avisa que não comprova idade", () => {
    render(<AgeGateView pathname="/" />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Classificação: 13+")).toBeTruthy();
    expect(screen.getByText(/não comprova sua idade/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Continuar" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("adulto declara e o portão some; o ano fica no aparelho", () => {
    render(<AgeGateView pathname="/" />);
    fireEvent.change(screen.getByLabelText("Em que ano você nasceu?"), {
      target: { value: "1990" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(readAgeDeclaration()?.birthYear).toBe(1990);
  });

  it("menor de 13: explica o modo só com bots", () => {
    const year = new Date().getFullYear() - 10;
    render(<AgeGateView pathname="/" />);
    fireEvent.change(screen.getByLabelText("Em que ano você nasceu?"), {
      target: { value: String(year) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByText("Modo só com bots")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Entendi" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("já declarou: não pergunta de novo", () => {
    saveAgeDeclaration(2000);
    render(<AgeGateView pathname="/" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("páginas de leitura (Termos, Privacidade…) não ficam atrás do portão", () => {
    for (const p of ["/terms", "/privacy", "/support", "/delete-account"]) {
      render(<AgeGateView pathname={p} />);
      expect(screen.queryByRole("dialog"), p).toBeNull();
      cleanup();
    }
  });
});
