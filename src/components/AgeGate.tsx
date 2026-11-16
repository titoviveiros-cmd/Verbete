import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  AGE_RATING_LABEL,
  AGE_SELF_DECLARATION_NOTICE,
  ageBandFromBirthYear,
  birthYearOptions,
  botsOnly,
  readAgeDeclaration,
  saveAgeDeclaration,
} from "@/lib/age";
import { isReadingPath } from "@/lib/viewport";

/**
 * Selo 13+ e pergunta neutra do ano de nascimento no PRIMEIRO acesso — ECA
 * Digital art. 8º V ("informar extensivamente … a faixa etária") e art. 14
 * p.ú. (mecanismo próprio). Proposta B5 (11/11/2026).
 *
 * Autodeclaração NÃO comprova idade (texto na tela e em lib/age.ts). O ano
 * fica só no aparelho. Não pergunta nada além do ano; não pede dado dos pais.
 * Páginas de leitura (Termos, Privacidade, Suporte, Excluir conta) abrem sem
 * a pergunta — informação legal não pode ficar atrás de um portão.
 */
export function AgeGate() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return <AgeGateView pathname={pathname} />;
}

/** O portão em si (sem roteador — testável isolado). */
export function AgeGateView({ pathname }: { pathname: string }) {
  // Só no cliente (o ano está no localStorage): evita divergir do HTML do SSR.
  const [declared, setDeclared] = useState<boolean | null>(null);
  const [year, setYear] = useState<string>("");
  const [under13Notice, setUnder13Notice] = useState(false);

  useEffect(() => {
    setDeclared(readAgeDeclaration() !== null);
  }, []);

  if (declared !== false && !under13Notice) return null;
  if (isReadingPath(pathname)) return null;

  const confirm = () => {
    const y = Number(year);
    if (!Number.isInteger(y)) return;
    saveAgeDeclaration(y);
    if (botsOnly(ageBandFromBirthYear(y))) setUnder13Notice(true);
    setDeclared(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
      className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center p-4"
    >
      <div className="w-full max-w-sm rounded-3xl bg-card border border-white/10 shadow-pop p-5 flex flex-col gap-3 text-center">
        <div
          className="mx-auto rounded-xl border-2 border-sun px-3 py-1 font-display text-2xl text-sun"
          aria-label={`Classificação: ${AGE_RATING_LABEL}`}
        >
          {AGE_RATING_LABEL}
        </div>
        {under13Notice ? (
          <>
            <h2 id="age-gate-title" className="font-display text-xl">
              Modo só com bots
            </h2>
            <p className="text-sm">
              O Verbete é para {AGE_RATING_LABEL}. Com menos de 13 anos, você
              joga só com bots: sem entrar em salas de outras pessoas e sem
              convidar ninguém.
            </p>
            <button
              onClick={() => setUnder13Notice(false)}
              className="btn-pop btn-gold"
            >
              Entendi
            </button>
          </>
        ) : (
          <>
            <h2 id="age-gate-title" className="font-display text-xl">
              O Verbete é para {AGE_RATING_LABEL}
            </h2>
            <label htmlFor="age-gate-year" className="text-sm">
              Em que ano você nasceu?
            </label>
            <select
              id="age-gate-year"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="bg-input rounded-xl px-3 py-2 border border-white/10 text-center"
            >
              <option value="">Escolha o ano</option>
              {birthYearOptions().map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {AGE_SELF_DECLARATION_NOTICE}
            </p>
            <button
              disabled={!year}
              onClick={confirm}
              className="btn-pop btn-gold"
            >
              Continuar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
