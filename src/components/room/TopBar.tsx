import { lazy, Suspense, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useNavigate } from "@tanstack/react-router";
import { SoundToggle } from "@/components/SoundToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LatencyIndicator } from "@/components/LatencyIndicator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Onboarding só carrega quando o jogador abre a ajuda.
const Onboarding = lazy(() =>
  import("@/components/Onboarding").then((m) => ({ default: m.Onboarding })),
);

export function TopBar({
  code,
  round,
  roundsTotal,
  status,
  isHost,
  onReset,
  onReload,
  degraded,
}: {
  code: string;
  round: number;
  /** Total de rodadas quando a partida termina por rodadas ("3/10"). */
  roundsTotal?: number;
  status: string;
  isHost?: boolean;
  onReset?: () => void;
  onReload?: () => void;
  /** Conexão degradada (poll falhando/offline) — mostra o "reconectar". */
  degraded?: boolean;
}) {
  const navigate = useNavigate();
  const [showLeave, setShowLeave] = useState(false);
  const canReset = isHost && status !== "lobby";
  const [showHelp, setShowHelp] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const handleReload = () => {
    if (!onReload) return;
    setSpinning(true);
    onReload();
    setTimeout(() => setSpinning(false), 700);
  };
  const btn =
    "glass-tile shrink-0 text-sm w-8 h-8 max-[380px]:w-[30px] max-[380px]:h-[30px] sm:w-9 sm:h-9 flex items-center justify-center rounded-full transition hover:brightness-110 active:translate-y-px";
  return (
    // Uma linha só até 360px (playtest 2026-10-20, 2ª rodada): em 360 os
    // ícones quebravam para uma 2ª linha e o topo congelava ~90px.
    <div className="flex items-center justify-between mb-3 max-[380px]:mb-2 gap-2 max-[380px]:gap-1.5 lg:mb-4">
      <div className="shrink-0">
        <p className="eyebrow">Código</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <p className="font-display text-[22px] lg:text-[26px] tracking-[0.22em] max-[380px]:tracking-[0.12em] text-sun leading-none tabular-nums">
            {code}
          </p>
          <LatencyIndicator code={code} />
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-wrap items-center justify-end gap-1.5 max-[380px]:gap-1">
        <button
          onClick={() => setShowLeave(true)}
          className={btn}
          title="Sair da sala"
          aria-label="Sair da sala"
        >
          🚪
        </button>
        <SoundToggle />
        <ThemeToggle />
        <button
          onClick={() => setShowHelp(true)}
          className={btn}
          title="Como jogar"
          aria-label="Como jogar"
        >
          ❔
        </button>
        {/* Fase 3 (decisão 2026-07-19): o 🔄 fixo virou ConnectionState —
            só aparece quando a conexão degrada (poll falhando/offline). */}
        {onReload && degraded && (
          <button
            onClick={handleReload}
            className={
              "shrink-0 flex items-center gap-1 px-2.5 h-9 rounded-full font-display text-[11px] " +
              "bg-sun/15 border border-sun text-sun animate-pulse transition" +
              (spinning ? " opacity-60" : "")
            }
            title="Conexão instável — toque para reconectar"
            aria-label="Conexão instável — toque para reconectar"
          >
            <span className={spinning ? "animate-spin" : ""}>🔄</span>
            reconectar
          </button>
        )}
        {canReset && (
          <button
            onClick={onReset}
            className={btn}
            title="Resetar jogo"
            aria-label="Resetar jogo"
          >
            ♻️
          </button>
        )}
      </div>
      {round > 0 && (
        <div className="text-right shrink-0">
          <p className="eyebrow">Rodada</p>
          <p className="font-display text-[22px] lg:text-[26px] text-pink leading-none tabular-nums mt-0.5">
            {round}
            {roundsTotal ? (
              <span className="text-sm text-muted-foreground">
                /{roundsTotal}
              </span>
            ) : null}
          </p>
        </div>
      )}
      <AnimatePresence>
        {showHelp && (
          <Suspense fallback={null}>
            <Onboarding onClose={() => setShowHelp(false)} />
          </Suspense>
        )}
      </AnimatePresence>
      <AlertDialog open={showLeave} onOpenChange={setShowLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sair da sala?</AlertDialogTitle>
            <AlertDialogDescription>
              Você voltará à tela inicial e perderá a rodada atual. Tem certeza?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Ficar na sala</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => navigate({ to: "/" })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Sair
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
