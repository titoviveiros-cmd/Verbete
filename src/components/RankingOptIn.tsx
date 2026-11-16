// Interruptor "Aparecer no ranking público" (B6, ECA Digital). Fica no Perfil
// e no Ranking. Padrão desligado; ligar pede o aceite dos Termos da sessão
// (o nome passa a ser visto por terceiros); desligar é um toque, sem nada.
import { useEffect, useId, useRef, useState } from "react";
import { TermsConsent } from "@/components/TermsConsent";
import { useTermsGate } from "@/hooks/use-terms-gate";
import {
  RANKING_OPT_IN_COPY,
  fetchRankingOptIn,
  setRankingOptIn,
} from "@/lib/ranking-opt-in";

export function RankingOptIn({
  userId,
  onValue,
  className = "",
}: {
  userId: string;
  /** Escolha lida ("load") ou gravada ("save"; o Ranking recarrega a lista). */
  onValue?: (value: boolean, source: "load" | "save") => void;
  className?: string;
}) {
  const id = useId();
  const terms = useTermsGate();
  const onValueRef = useRef(onValue);
  useEffect(() => {
    onValueRef.current = onValue;
  });
  const [value, setValue] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setValue(null);
    setFailed(false);
    fetchRankingOptIn(userId).then((v) => {
      if (!alive) return;
      setValue(v);
      setFailed(v === null);
      if (v !== null) onValueRef.current?.(v, "load");
    });
    return () => {
      alive = false;
    };
  }, [userId]);

  const toggle = async () => {
    if (value === null || saving) return;
    const next = !value;
    // Ligar = conteúdo à vista de terceiros: a caixa dos Termos vale aqui.
    // Ela só aparece quando alguém tenta ligar (como no "editar nome"): abrir
    // o Perfil continua sem caixa nenhuma.
    if (next) {
      setAsked(true);
      if (!terms.confirm()) return;
    }
    setSaving(true);
    setError(null);
    try {
      await setRankingOptIn(userId, next);
      setValue(next);
      onValue?.(next, "save");
    } catch {
      setError("Não deu para salvar agora. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  const on = value === true;
  return (
    <div
      className={`sticker py-3 px-4 flex flex-col gap-2 ${className}`}
      data-testid="ranking-opt-in"
    >
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="flex-1 font-display text-sm">
          {RANKING_OPT_IN_COPY.label}
        </label>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          aria-describedby={`${id}-ajuda`}
          disabled={value === null || saving}
          onClick={toggle}
          className={
            "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 " +
            (on ? "bg-mint border-mint" : "bg-muted border-border")
          }
        >
          <span
            aria-hidden
            className={
              "inline-block h-5 w-5 rounded-full bg-background shadow transition-transform " +
              (on ? "translate-x-6" : "translate-x-1")
            }
          />
        </button>
      </div>
      <p
        id={`${id}-ajuda`}
        className="text-[11px] text-muted-foreground leading-snug"
      >
        {on ? RANKING_OPT_IN_COPY.on : RANKING_OPT_IN_COPY.off}
      </p>
      {asked && !on && <TermsConsent gate={terms} />}
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          Não deu para carregar sua escolha agora.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
