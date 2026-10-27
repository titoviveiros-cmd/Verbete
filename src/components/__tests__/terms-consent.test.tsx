import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { TermsConsent } from "../TermsConsent";
import { useTermsGate } from "@/hooks/use-terms-gate";
import { acceptTerms, hasAcceptedTerms } from "@/lib/terms-consent";

// Formulário mínimo: o "Enviar" só cria conteúdo se o gate liberar.
function Form() {
  const gate = useTermsGate();
  const [sent, setSent] = useState(0);
  return (
    <div>
      <TermsConsent gate={gate} />
      <button onClick={() => gate.confirm() && setSent((n) => n + 1)}>
        Enviar
      </button>
      <output data-testid="sent">{sent}</output>
    </div>
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("TermsConsent", () => {
  it("aparelho novo: caixa DESMARCADA, com nome acessível e links para Termos e Privacidade", () => {
    render(<Form />);
    const box = screen.getByRole("checkbox", {
      name: /Li e aceito os Termos de Uso e a Política de Privacidade/,
    });
    expect(box).not.toBeChecked();
    const termos = screen.getByRole("link", { name: "Termos de Uso" });
    const privacidade = screen.getByRole("link", {
      name: "Política de Privacidade",
    });
    expect(termos.getAttribute("href")).toMatch(/\/terms$/);
    expect(privacidade.getAttribute("href")).toMatch(/\/privacy$/);
    for (const a of [termos, privacidade]) {
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toMatch(/noopener/);
    }
  });

  it("enviar SEM marcar não cria conteúdo: avisa, marca inválido e leva o foco à caixa", () => {
    render(<Form />);
    fireEvent.click(screen.getByText("Enviar"));
    expect(screen.getByTestId("sent")).toHaveTextContent("0");
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent(
      "Para continuar, aceite os Termos de Uso.",
    );
    const box = screen.getByRole("checkbox");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box.getAttribute("aria-describedby")).toBe(alerta.id);
    expect(document.activeElement).toBe(box);
    expect(hasAcceptedTerms()).toBe(false);
  });

  it("marcar e enviar registra o aceite, envia e a caixa some", () => {
    render(<Form />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByText("Enviar"));
    expect(screen.getByTestId("sent")).toHaveTextContent("1");
    expect(hasAcceptedTerms()).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("navegar nos links não é aceite", () => {
    render(<Form />);
    fireEvent.click(screen.getByRole("link", { name: "Termos de Uso" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(hasAcceptedTerms()).toBe(false);
  });

  it("aparelho que já aceitou: nada aparece e o envio sai direto (sem modal por partida)", () => {
    acceptTerms();
    render(<Form />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByText("Enviar"));
    expect(screen.getByTestId("sent")).toHaveTextContent("1");
  });

  it("aceite em outra parte do app esconde a caixa já aberta (mesma aba)", () => {
    render(<Form />);
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    act(() => acceptTerms());
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
