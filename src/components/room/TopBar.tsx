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
  status,
  isHost,
  onReset,
  onReload,
}: {
  code: string;
  round: number;
  status: string;
  isHost?: boolean;
  onReset?: () => void;
  onReload?: () => void;
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
    "shrink-0 opacity-70 hover:opacity-100 text-sm w-7 h-7 flex items-center justify-center rounded-full bg-card/50 border border-white/10 transition";
  return (
    <div className="flex items-start justify-between mb-3 gap-2">
      <div className="text-xs shrink-0">
        <p className="text-muted-foreground uppercase tracking-wider font-display">
          Código:
        </p>
        <div className="flex items-center gap-1.5">
          <p className="font-display text-xl tracking-[0.25em] text-sun leading-none">
            {code}
          </p>
          <LatencyIndicator code={code} />
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-wrap items-center justify-end gap-1.5">
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
        {onReload && (
          <button
            onClick={handleReload}
            className={btn + (spinning ? " animate-spin" : "")}
            title="Atualizar sala"
            aria-label="Atualizar sala"
          >
            🔄
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
        <div className="text-right text-xs shrink-0">
          <p className="text-muted-foreground uppercase tracking-wider font-display">
            Rodada
          </p>
          <p className="font-display text-xl text-pink leading-none">{round}</p>
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
            <AlertDialogAction onClick={() => navigate({ to: "/" })}>
              Sair
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
