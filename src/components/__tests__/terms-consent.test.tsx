import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { TermsConsent } from "../TermsConsent";
import { useTermsGate, type TermsGate } from "@/hooks/use-terms-gate";
import {
  acceptTerms,
  assertTermsAccepted,
  hasAcceptedTerms,
} from "@/lib/terms-consent";
import { ensureAnonSession } from "@/lib/auth-session";
import { account, anon, fakeAuth } from "@/test/fake-auth";

vi.mock(
  "@/integrations/supabase/client",
  async () => (await import("@/test/fake-auth")).supabaseModule,
);

// Formulário mínimo: o "Enviar" só cria conteúdo se o gate liberar — e a
// gravação confere a identidade da sessão, como as funções reais.
let gateNow: TermsGate | null = null;
function Form({
  always = false,
  auto = false,
}: {
  always?: boolean;
  auto?: boolean;
}) {
  const gate = useTermsGate({ always });
  gateNow = gate;
  const [sent, setSent] = useState(0);
  return (
    <div>
      <textarea aria-label="palpite" />
      <TermsConsent gate={gate} />
      <button
        onClick={async () => {
          if (!gate.confirm({ focus: !auto })) return;
          await assertTermsAccepted();
          setSent((n) => n + 1);
        }}
      >
        Enviar
      </button>
      <output data-testid="sent">{sent}</output>
    </div>
  );
}

let seq = 0;
/** Identidade nova a cada teste (o estado do módulo segue entre testes). */
const fresh = () =>
  `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

beforeEach(() => {
  localStorage.clear();
  fakeAuth.reset(anon(fresh()));
});
afterEach(cleanup);

describe("TermsConsent", () => {
  it("identidade sem aceite: caixa DESMARCADA, com nome acessível e links para Termos e Privacidade", () => {
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

  it("envio automático (tempo esgotado) sem aceite: avisa SEM tirar o foco de quem digita", () => {
    render(<Form auto />);
    const palpite = screen.getByLabelText("palpite");
    palpite.focus();
    fireEvent.click(screen.getByText("Enviar"));
    expect(screen.getByTestId("sent")).toHaveTextContent("0");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(document.activeElement).toBe(palpite);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("marcar e enviar registra o aceite, envia e a caixa some", async () => {
    render(<Form />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByText("Enviar"));
    expect(await screen.findByText("1")).toBeInTheDocument();
    expect(hasAcceptedTerms()).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("navegar nos links não é aceite", () => {
    render(<Form />);
    fireEvent.click(screen.getByRole("link", { name: "Termos de Uso" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(hasAcceptedTerms()).toBe(false);
  });

  it("identidade que já aceitou: nada aparece e o envio sai direto (sem modal por partida)", async () => {
    acceptTerms();
    render(<Form />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByText("Enviar"));
    expect(await screen.findByText("1")).toBeInTheDocument();
  });

  it("aceite em outra parte do app esconde a caixa já aberta (mesma aba)", () => {
    render(<Form />);
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    act(() => acceptTerms());
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("a tela segue a sessão: o aceite de A não esconde a caixa quando B entra", () => {
    const a = fresh();
    act(() => fakeAuth.set(account(a)));
    acceptTerms();
    render(<Form />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    act(() => fakeAuth.set(null)); // logout de A
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    act(() => fakeAuth.set(account(fresh()))); // B
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    act(() => fakeAuth.set(account(a))); // A volta: sem pedir de novo
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("trocou de conta com a caixa marcada: para B ela volta DESMARCADA (nada pré-marcado)", () => {
    render(<Form />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).toBeChecked();
    act(() => fakeAuth.set(account(fresh())));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByText("Enviar"));
    expect(screen.getByTestId("sent")).toHaveTextContent("0");
    expect(hasAcceptedTerms()).toBe(false);
  });

  it("G: clique logo após a troca de conta (antes de redesenhar) não passa", () => {
    acceptTerms(); // A aceitou; a tela é a de A
    render(<Form />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    let ok = true;
    act(() => {
      fakeAuth.set(account(fresh())); // B entra…
      ok = gateNow!.confirm(); // …e o clique usa a tela velha
    });
    expect(ok).toBe(false);
    expect(hasAcceptedTerms()).toBe(false);
  });

  it("identidade carregando: a caixa não pisca para quem já aceitou", async () => {
    acceptTerms();
    fakeAuth.hold();
    vi.resetModules();
    const { TermsConsent: Caixa } = await import("../TermsConsent");
    const { useTermsGate: gate } = await import("@/hooks/use-terms-gate");
    function Boot() {
      return <Caixa gate={gate()} />;
    }
    render(<Boot />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    act(() => fakeAuth.release());
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("always (Criar conta): a caixa aparece mesmo com o aceite da identidade em vigor", () => {
    acceptTerms();
    render(<Form always />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByText("Enviar"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("sent")).toHaveTextContent("0");
  });

  it("always (Criar conta): marcar e cadastrar NÃO vale para o convidado desta aba", () => {
    render(<Form always />);
    fireEvent.click(screen.getByRole("checkbox"));
    let ok = false;
    act(() => {
      ok = gateNow!.confirm(); // o cadastro segue (a conta criada recebe o aceite)
    });
    expect(ok).toBe(true);
    expect(hasAcceptedTerms()).toBe(false); // o convidado segue sem aceite
  });

  it("sem sessão: depois do logout a caixa vem na hora; enquanto o app abre uma, espera a identidade", async () => {
    const id = fresh();
    act(() => fakeAuth.set(anon(id)));
    acceptTerms(); // a identidade que vai voltar já aceitou neste aparelho
    act(() => fakeAuth.set(null)); // sem sessão e nada sendo aberto
    render(<Form />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fakeAuth.holdAnonymous();
    let opening!: Promise<boolean>;
    await act(async () => {
      opening = ensureAnonSession(); // o boot abrindo a sessão anônima
    });
    expect(screen.queryByRole("checkbox")).toBeNull(); // carregando: sem piscar
    await act(async () => {
      fakeAuth.finishAnonymous(id);
      await opening;
    });
    expect(screen.queryByRole("checkbox")).toBeNull(); // chegou quem já aceitou
    // falhou ao abrir (sem rede): volta a pedir o aceite
    act(() => fakeAuth.set(null));
    fakeAuth.holdAnonymous();
    await act(async () => {
      opening = ensureAnonSession();
    });
    expect(screen.queryByRole("checkbox")).toBeNull();
    vi.useFakeTimers();
    try {
      await act(async () => {
        fakeAuth.finishAnonymous(null);
        await vi.runAllTimersAsync(); // as 2 novas tentativas, sem rede
        await opening;
      });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});
