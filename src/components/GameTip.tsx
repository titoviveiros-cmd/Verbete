import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import { getStored, setStored } from "@/lib/player-id";

type Tip = { phase: string; title: string; body: string };

const TIPS: Tip[] = [
  { phase: "lobby", title: "Bem-vindo!", body: "Convide amigos com o código da sala. Quando todos chegarem, o host clica em 'Começar'." },
  { phase: "choosing", title: "Escolhendo a palavra", body: "Quem coordena escolhe uma palavra rara. Os outros vão tentar enganar a galera com definições inventadas ou até mesmo com o significado verdadeiro." },
  { phase: "writing", title: "Hora de blefar", body: "Invente uma definição que pareça real! O objetivo é convencer os outros de que sua versão é a verdadeira." },
  { phase: "voting", title: "Escolha a verdade", body: "Vote na definição que você acredita ser a real. +3 pontos por acertar e +1 para cada pessoa que cair no seu blefe." },
  { phase: "reveal", title: "A verdade aparece", body: "A definição real é revelada e os pontos são distribuídos. Boa rodada!" },
];

export function GameTip({ phase, round }: { phase: string; round: number }) {
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = getStored<string>("tutorial-seen-phases", "");
    const map: Record<string, boolean> = {};
    stored.split(",").filter(Boolean).forEach((p) => (map[p] = true));
    setDismissed(map);
  }, []);

  useEffect(() => { setHidden(false); }, [phase]);

  // Só mostra na 1ª rodada e na 1ª vez que o jogador vê cada fase
  if (round > 1 || hidden || dismissed[phase]) return null;
  const tip = TIPS.find((t) => t.phase === phase);
  if (!tip) return null;

  const close = () => {
    const next = { ...dismissed, [phase]: true };
    setDismissed(next);
    setStored("tutorial-seen-phases", Object.keys(next).join(","));
    setHidden(true);
  };

  return (
    <AnimatePresence>
      <motion.div
        role="dialog"
        aria-labelledby="tip-title"
        aria-describedby="tip-body"
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        className="fixed left-3 right-3 bottom-24 z-40 mx-auto max-w-sm rounded-2xl border border-white/15 bg-card/95 backdrop-blur p-3 shadow-pop"
      >
        <div className="flex items-start gap-2">
          <span className="text-2xl" aria-hidden="true">💡</span>
          <div className="flex-1 min-w-0">
            <p id="tip-title" className="font-display text-sm">{tip.title}</p>
            <p id="tip-body" className="text-xs text-muted-foreground mt-0.5">{tip.body}</p>
          </div>
          <button
            onClick={close}
            aria-label="Fechar dica"
            className="rounded-full w-7 h-7 flex items-center justify-center bg-white/10 hover:bg-white/20 text-sm focus-visible:ring-2 focus-visible:ring-pink"
          >✕</button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}


