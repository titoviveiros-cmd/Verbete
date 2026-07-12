import { AnimatePresence, motion } from "framer-motion";
import { memo, useEffect, useRef, useState } from "react";

// Tempo total real da transição, incluindo o fade-out do overlay + buffer.
// Componentes de fases (Reveal/Scoreboard) usam essa constante para só iniciar
// contagens regressivas APÓS a cortina sair completamente da tela e o overlay
// estar totalmente invisível, garantindo leitura limpa do conteúdo.
export const PHASE_ANNOUNCER_TOTAL_MS = 3800;
const CURTAIN_VISIBLE_MS = 3000;
// A etiqueta de incentivo aparece por menos tempo que a cortina:
const LABEL_VISIBLE_MS = 1800;

const LABELS: Record<string, { title: string; emoji: string; tint: string }> = {
  lobby:      { title: "Sala de Espera", emoji: "🛋️", tint: "from-sun/30 via-transparent to-transparent" },
  choosing:   { title: "Escolha da Palavra", emoji: "📖", tint: "from-coral/30 via-transparent to-transparent" },
  writing:    { title: "Hora de Inventar", emoji: "✍️", tint: "from-mint/30 via-transparent to-transparent" },
  // shuffling: intencionalmente sem cortina — a própria fase Shuffling já mostra
  // uma tela cheia animada "Embaralhando as cédulas…", evitando duplicidade.
  // voting: intencionalmente sem cortina — a fase Shuffling imediatamente
  // anterior já é uma tela cheia de transição ("Embaralhando as cédulas"),
  // então mostrar outra cortina logo depois soa duplicado.
  reveal:     { title: "Revelação!", emoji: "✨", tint: "from-sun/40 via-transparent to-transparent" },
  scoreboard: { title: "Placar da Rodada", emoji: "🏆", tint: "from-mint/30 via-transparent to-transparent" },
  finished:   { title: "Fim de Jogo", emoji: "🎉", tint: "from-sun/40 via-transparent to-transparent" },
};

export const PhaseAnnouncer = memo(function PhaseAnnouncer({ status }: { status: string }) {
  const [show, setShow] = useState(false);
  const [labelOn, setLabelOn] = useState(false);
  const prev = useRef(status);

  useEffect(() => {
    if (prev.current === status) return;
    prev.current = status;
    if (status === "lobby") return;
    setShow(true);
    setLabelOn(true);
    const tLabel = setTimeout(() => setLabelOn(false), LABEL_VISIBLE_MS);
    const tShow = setTimeout(() => setShow(false), CURTAIN_VISIBLE_MS);
    return () => { clearTimeout(tLabel); clearTimeout(tShow); };
  }, [status]);

  const cfg = LABELS[status];
  if (!cfg) return null;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key={status}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6 }}
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-hidden"
        >
          {/* underlay opaco — garante que NENHUMA informação da fase anterior/próxima
              fique visível por trás do card de transição. Cobre a tela toda durante
              quase toda a cortina e só some no finalzinho junto com o overlay. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 1, 1] }}
            transition={{ duration: 0.5, times: [0, 0.4, 0.9, 1] }}
            className="absolute inset-0 bg-background"
          />
          {/* deep shadow base — anchors the curtain */}
          <motion.div
            initial={{ x: "-115%", skewX: "-14deg" }}
            animate={{ x: "115%", skewX: "-14deg" }}
            transition={{ duration: 2.8, ease: [0.77, 0, 0.18, 1] }}
            className="absolute -inset-y-10 -inset-x-20 bg-gradient-to-r from-transparent via-background/95 to-transparent backdrop-blur-md"
          />
          {/* tinted main curtain */}
          <motion.div
            initial={{ x: "-115%", skewX: "-12deg" }}
            animate={{ x: "115%", skewX: "-12deg" }}
            transition={{ duration: 2.8, ease: [0.77, 0, 0.18, 1], delay: 0.12 }}
            className={`absolute -inset-y-10 -inset-x-20 bg-gradient-to-r ${cfg.tint}`}
          />
          {/* bright leading edge — the "blade" */}
          <motion.div
            initial={{ x: "-115%", skewX: "-12deg" }}
            animate={{ x: "115%", skewX: "-12deg" }}
            transition={{ duration: 2.8, ease: [0.77, 0, 0.18, 1], delay: 0.06 }}
            className="absolute -inset-y-10 w-[18vw] bg-gradient-to-r from-transparent via-white/70 to-transparent mix-blend-overlay blur-md"
          />
          {/* trailing shimmer */}
          <motion.div
            initial={{ x: "-115%", skewX: "-12deg" }}
            animate={{ x: "115%", skewX: "-12deg" }}
            transition={{ duration: 3.0, ease: [0.7, 0, 0.2, 1], delay: 0.28 }}
            className="absolute -inset-y-10 w-[10vw] bg-gradient-to-r from-transparent via-white/30 to-transparent blur-2xl"
          />
          {/* film grain shimmer pass — fade out junto com a cortina */}
          <motion.div
            initial={{ x: "-110%", opacity: 0.4 }}
            animate={{ x: "110%", opacity: [0.4, 0.4, 0] }}
            transition={{ duration: 2.6, ease: [0.65, 0, 0.35, 1], delay: 0.4, times: [0, 0.75, 1] }}
            className="absolute inset-0"
            style={{
              backgroundImage:
                "repeating-linear-gradient(115deg, rgba(255,255,255,0.06) 0 2px, transparent 2px 9px)",
            }}
          />
          {/* sparkle particles riding the curtain */}
          {[...Array(7)].map((_, i) => (
            <motion.span
              key={i}
              initial={{ x: "-20vw", opacity: 0, scale: 0.4 }}
              animate={{
                x: "120vw",
                opacity: [0, 1, 1, 0],
                scale: [0.4, 1.1, 0.9, 0.4],
              }}
              transition={{
                duration: 2.8,
                ease: [0.77, 0, 0.18, 1],
                delay: 0.1 + i * 0.18,
              }}
              className="absolute w-2 h-2 rounded-full bg-white shadow-[0_0_18px_6px_rgba(255,255,255,0.8)]"
              style={{ top: `${15 + i * 11}%` }}
            />
          ))}
          {/* radial glow pulse — desaparece bem antes do fim da transição */}
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: [0, 1.4, 1.1], opacity: [0, 0.55, 0] }}
            transition={{ duration: 2.0, ease: "easeOut", delay: 0.3 }}
            className="absolute w-[120vmin] h-[120vmin] rounded-full bg-gradient-radial from-white/25 via-transparent to-transparent blur-3xl"
          />
          {/* label — desaparece bem antes da cortina */}
          <AnimatePresence>
            {labelOn && (
              <motion.div
                initial={{ scale: 0.6, opacity: 0, y: 40, rotate: -4 }}
                animate={{ scale: 1, opacity: 1, y: 0, rotate: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: -20, rotate: 2 }}
                transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
                className="relative flex flex-col items-center gap-2 px-6 py-4 rounded-3xl bg-card/90 border-2 border-white/20 shadow-2xl backdrop-blur-md max-w-[88vw]"
              >
                <motion.span
                  initial={{ scale: 0.5, rotate: -20 }}
                  animate={{ scale: [0.5, 1.3, 1], rotate: [-20, 10, 0] }}
                  transition={{ duration: 0.7, ease: "easeOut" }}
                  className="text-5xl drop-shadow-lg"
                >
                  {cfg.emoji}
                </motion.span>
                <motion.span
                  initial={{ opacity: 0, letterSpacing: "0.4em" }}
                  animate={{ opacity: 1, letterSpacing: "0.05em" }}
                  transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
                  className="font-display text-xl tracking-wide text-center leading-tight text-balance"
                >
                  {cfg.title}
                </motion.span>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
});


