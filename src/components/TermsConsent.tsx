// Caixa de aceite dos Termos (lib/terms-consent): só aparece enquanto a
// identidade em vigor (sessão anônima ou conta) não aceitou a versão atual.
// O aceite vale no clique de criar conteúdo (Criar/Entrar/Enviar/Criar conta/
// palpite) com a caixa marcada; sem ela, o envio não sai e a caixa recebe o
// foco com o aviso. Estado: hooks/use-terms-gate.
import { useId } from "react";
import { APP_URL } from "@/lib/app-url";
import type { TermsGate } from "@/hooks/use-terms-gate";

export function TermsConsent({
  gate,
  className = "",
}: {
  gate: TermsGate;
  className?: string;
}) {
  const id = useId();
  if (!gate.needed) return null;
  const errorId = `${id}-erro`;
  // Links absolutos (APP_URL): no app nativo abrem no navegador sem perder
  // o que já foi digitado; no web, em outra aba.
  return (
    <div className={`text-left ${className}`}>
      <label
        htmlFor={id}
        className="flex items-start gap-2.5 min-h-6 text-[13px] leading-snug text-muted-foreground cursor-pointer"
      >
        <input
          ref={gate.inputRef}
          id={id}
          type="checkbox"
          data-testid="terms-consent"
          checked={gate.checked}
          onChange={(e) => gate.setChecked(e.target.checked)}
          aria-invalid={gate.error || undefined}
          aria-describedby={gate.error ? errorId : undefined}
          className="mt-0.5 h-5 w-5 shrink-0 accent-pink cursor-pointer"
        />
        <span>
          Li e aceito os{" "}
          <a
            href={`${APP_URL}/terms`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-bold text-foreground"
          >
            Termos de Uso
          </a>{" "}
          e a{" "}
          <a
            href={`${APP_URL}/privacy`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-bold text-foreground"
          >
            Política de Privacidade
          </a>
          .
        </span>
      </label>
      {gate.error && (
        <p
          id={errorId}
          role="alert"
          className="mt-1 pl-[30px] text-[12px] font-bold text-pink"
        >
          Para continuar, aceite os Termos de Uso.
        </p>
      )}
    </div>
  );
}
