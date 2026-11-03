import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import { getStored, setStored } from "@/lib/player-id";

type Tip = { phase: string; title: string; body: string };

const TIPS: Tip[] = [
  {
    phase: "lobby",
    title: "Convide os amigos",
    body: "Compartilhe o código ou o link da sala. Com pelo menos 4 participantes, contando os bots, o anfitrião pode começar.",
  },
  {
    phase: "choosing",
    title: "Escolha da palavra",
    body: "O coordenador escolhe uma entre três palavras sorteadas. O significado fica em segredo.",
  },
  {
    phase: "writing",
    title: "Crie sua definição",
    body: "Invente um significado convincente ou tente acertar o verdadeiro. Envie antes que o tempo acabe.",
  },
  {
    phase: "voting",
    title: "Hora de votar",
    body: "Escolha a definição que parece verdadeira. Acertar vale 3 pontos, e cada voto no seu blefe vale 1.",
  },
  {
    phase: "reveal",
    title: "Hora da verdade",
    body: "Veja qual era a resposta certa, quem acertou e quem conseguiu enganar os outros.",
  },
];

export function GameTip({ phase, round }: { phase: string; round: number }) {
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = getStored<string>("tutorial-seen-phases", "");
    const map: Record<string, boolean> = {};
    stored
      .split(",")
      .filter(Boolean)
      .forEach((p) => (map[p] = true));
    setDismissed(map);
  }, []);

  useEffect(() => {
    setHidden(false);
  }, [phase]);

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
          <span className="text-2xl" aria-hidden="true">
            💡
          </span>
          <div className="flex-1 min-w-0">
            <p id="tip-title" className="font-display text-sm">
              {tip.title}
            </p>
            <p id="tip-body" className="text-xs text-muted-foreground mt-0.5">
              {tip.body}
            </p>
          </div>
          <button
            onClick={close}
            aria-label="Fechar dica"
            className="rounded-full w-7 h-7 flex items-center justify-center bg-white/10 hover:bg-white/20 text-sm focus-visible:ring-2 focus-visible:ring-pink"
          >
            ✕
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
