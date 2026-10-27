// Estado da caixa de aceite dos Termos (components/TermsConsent) num
// formulário que cria conteúdo: Criar/Entrar/Enviar/Criar conta chamam
// confirm() antes de enviar — com a caixa marcada, registra o aceite.
import { useRef, useState, type RefObject } from "react";
import {
  acceptTerms,
  hasAcceptedTerms,
  useTermsAccepted,
} from "@/lib/terms-consent";

export type TermsGate = {
  /** Mostrar a caixa (aparelho ainda sem o aceite desta versão). */
  needed: boolean;
  checked: boolean;
  setChecked: (v: boolean) => void;
  error: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /** No clique de envio: true = pode criar conteúdo (registra o aceite). */
  confirm: () => boolean;
};

export function useTermsGate(): TermsGate {
  const accepted = useTermsAccepted();
  const [checked, setCheckedState] = useState(false);
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return {
    needed: accepted === false,
    checked,
    setChecked: (v) => {
      setCheckedState(v);
      if (v) setError(false);
    },
    error,
    inputRef,
    confirm: () => {
      if (hasAcceptedTerms()) return true;
      if (checked) {
        acceptTerms();
        setError(false);
        return true;
      }
      setError(true);
      inputRef.current?.focus();
      return false;
    },
  };
}
