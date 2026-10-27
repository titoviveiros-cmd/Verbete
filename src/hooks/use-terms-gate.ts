// Estado da caixa de aceite dos Termos (components/TermsConsent) num
// formulário que cria conteúdo: Criar/Entrar/Enviar/Criar conta chamam
// confirm() antes de enviar — com a caixa marcada, registra o aceite da
// identidade em vigor. A gravação em si confere de novo (assertTermsAccepted).
import { useRef, useState, type RefObject } from "react";
import {
  acceptTerms,
  hasAcceptedTerms,
  useTermsAccepted,
  useTermsIdentity,
} from "@/lib/terms-consent";

export type TermsGate = {
  /** Mostrar a caixa (a identidade em vigor ainda não aceitou esta versão). */
  needed: boolean;
  checked: boolean;
  setChecked: (v: boolean) => void;
  error: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /**
   * No envio: true = pode seguir para a gravação. focus: false no envio
   * automático (tempo esgotado) — o aviso aparece sem tirar o foco de quem
   * digita (uma tecla de espaço marcaria a caixa sem querer).
   */
  confirm: (opts?: { focus?: boolean }) => boolean;
};

/**
 * always: a caixa aparece mesmo que a identidade em vigor já tenha aceitado
 * — criar conta é outro titular (aparelho compartilhado), aceite explícito.
 */
export function useTermsGate(opts: { always?: boolean } = {}): TermsGate {
  const always = !!opts.always;
  const accepted = useTermsAccepted();
  const identity = useTermsIdentity();
  const [checked, setCheckedState] = useState(false);
  const [error, setError] = useState(false);
  const [owner, setOwner] = useState(identity);
  const inputRef = useRef<HTMLInputElement>(null);
  // Trocou a identidade (logout, outra conta): a caixa volta DESMARCADA — o
  // "li e aceito" de A não vale para B, nem aparece pré-marcado para ele.
  if (owner !== identity) {
    setOwner(identity);
    if (typeof owner === "string") {
      setCheckedState(false);
      setError(false);
    }
  }
  return {
    needed: always || accepted === false,
    checked,
    setChecked: (v) => {
      setCheckedState(v);
      if (v) setError(false);
    },
    error,
    inputRef,
    confirm: ({ focus = true } = {}) => {
      if (!always && hasAcceptedTerms()) return true;
      if (checked) {
        // always (cadastro): o aceite é da conta criada (acceptTermsFor),
        // não do convidado desta aba
        if (!always) acceptTerms();
        setError(false);
        return true;
      }
      // Identidade ainda carregando: quem decide é a trava da gravação, que
      // lê o UID da sessão (nada sai sem o aceite dele).
      if (!always && accepted === null) return true;
      setError(true);
      if (focus) inputRef.current?.focus();
      return false;
    },
  };
}
