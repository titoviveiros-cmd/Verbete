import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { memo, useEffect, useRef, useState } from "react";
import { Mascot } from "@/components/Mascot";
import { hapticTick } from "@/lib/sound";

// Tempo total real da transição, incluindo a saída do overlay + folga. O
// Placar usa essa constante para só iniciar a contagem regressiva DEPOIS que
// a transição sai da tela, e o alerta de "sua vez" toca depois dela.
export const PHASE_ANNOUNCER_TOTAL_MS = 3500;
// Playtest 2026-10-20: a cortina antiga (3 s de varredura com faíscas,
// granulado e um emoji gigante) parecia genérica e lenta. A nova é um
// verbete da marca — o mascote-livro, a rodada, o título em ouro com aresta e
// um fio dourado que se desenha. Só transform e opacidade: nada de
// backdrop-blur em tela cheia (caro no Android). Tempo de tela: 2,8 s (2º
// playtest de 2026-10-20: 2,2 s era rápido para ler rodada + título + dica;
// a dica entra em ~0,3 s e fica ~2,5 s legível).
const CURTAIN_VISIBLE_MS = 2800;
const EXIT_S = 0.45;

type Mood = "idle" | "excited" | "thinking" | "wow" | "sad";
type Cfg = {
  title: string;
  hint: string;
  mood: Mood;
  /** Halo atrás do mascote: a cor da fase no resto do jogo. */
  halo: string;
  eyebrow: (round: number) => string;
};

const LABELS: Record<string, Cfg> = {
  choosing: {
    title: "Escolha da Palavra",
    hint: "Uma palavra rara vai sair do dicionário",
    mood: "thinking",
    halo: "rgb(244 197 66 / 0.32)",
    eyebrow: (r) => `Rodada ${r}`,
  },
  writing: {
    title: "Hora de Inventar",
    hint: "Escreva um significado que engane a mesa",
    mood: "excited",
    halo: "rgb(255 63 174 / 0.3)",
    eyebrow: (r) => `Rodada ${r}`,
  },
  // shuffling: intencionalmente sem cortina — a própria fase Shuffling já é
  // uma tela cheia animada ("Embaralhando as cédulas"), evitando duplicidade.
  // voting: intencionalmente sem cortina — o embaralhamento imediatamente
  // anterior já é a transição; outra cortina logo depois soa duplicada.
  // reveal: intencionalmente sem cortina (2026-10-20, "verdade primeiro") — a
  // própria Revelação abre com uma preparação de ~0,5 s e mostra a verdade em
  // seguida; uma cortina atrasaria justamente o momento principal.
  scoreboard: {
    title: "Placar da Rodada",
    hint: "Quem enganou quem — e quanto valeu",
    mood: "wow",
    halo: "rgb(45 212 191 / 0.28)",
    eyebrow: (r) => `Fim da rodada ${r}`,
  },
  finished: {
    title: "Fim de Jogo",
    hint: "E o grande verbetista da noite é…",
    mood: "excited",
    halo: "rgb(244 197 66 / 0.38)",
    eyebrow: () => "Partida encerrada",
  },
};

export const PhaseAnnouncer = memo(function PhaseAnnouncer({
  status,
  round = 0,
}: {
  status: string;
  round?: number;
}) {
  const [show, setShow] = useState(false);
  const prev = useRef(status);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (prev.current === status) return;
    prev.current = status;
    if (!LABELS[status]) return;
    setShow(true);
    hapticTick(); // Fase 5: tique tátil na virada de fase
    const t = setTimeout(() => setShow(false), CURTAIN_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [status]);

  const cfg = LABELS[status];
  if (!cfg) return null;

  // Entrada em cascata curta (≈0,7 s até o último elemento); com movimento
  // reduzido, só opacidade.
  const rise = (delay: number, y = 10) =>
    reduce
      ? {
          initial: { opacity: 0 },
          animate: { opacity: 1 },
          transition: { duration: 0.2 },
        }
      : {
          initial: { opacity: 0, y },
          animate: { opacity: 1, y: 0 },
          transition: {
            delay,
            type: "spring" as const,
            stiffness: 260,
            damping: 22,
          },
        };

  return (
    <>
      {/* Fase 7: leitor de tela anuncia a fase (a transição é só visual) */}
      <span className="sr-only" role="status" aria-live="polite">
        {show ? cfg.title : ""}
      </span>
      <AnimatePresence>
        {show && (
          <motion.div
            key={status}
            data-phase-announcer={status}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.22 } }}
            exit={{ opacity: 0, transition: { duration: EXIT_S } }}
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-hidden"
          >
            {/* fundo opaco: nada da fase anterior/próxima aparece por trás */}
            <div className="absolute inset-0 bg-background" />
            <div
              className="absolute inset-0"
              style={{ background: "var(--stage-glow)" }}
            />
            {/* halo da fase — uma cor só, a mesma da fase no resto do jogo */}
            <motion.div
              aria-hidden
              className="absolute aspect-square w-[min(125vw,680px)] rounded-full"
              style={{
                background: `radial-gradient(closest-side, ${cfg.halo}, transparent 72%)`,
              }}
              initial={{ scale: 0.55, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
            />
            <motion.div
              className="relative flex flex-col items-center text-center px-8 max-w-[24rem]"
              exit={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, y: -14, transition: { duration: EXIT_S } }
              }
            >
              <motion.div
                className="relative"
                initial={
                  reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.8 }
                }
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={
                  reduce
                    ? { duration: 0.2 }
                    : { type: "spring", stiffness: 320, damping: 17 }
                }
              >
                {/* sombra de chão: o livro "pousa" no palco */}
                <div
                  aria-hidden
                  className="absolute left-1/2 -translate-x-1/2 -bottom-1 h-4 w-24 rounded-full bg-black/35 blur-md"
                />
                <Mascot mood={cfg.mood} size={104} className="relative" />
              </motion.div>
              <motion.p
                className="eyebrow mt-3 !text-[var(--c-gold-low)] tabular-nums"
                {...rise(0.08, 6)}
              >
                {cfg.eyebrow(round)}
              </motion.p>
              <motion.h2
                className="font-display text-[34px] min-[400px]:text-[38px] leading-[1.05] mt-1.5 text-balance text-gold-grad"
                style={{
                  // aresta dourada (a mesma das peças candy) — dá corpo ao
                  // ouro no escuro e leitura no tema creme
                  filter:
                    "drop-shadow(0 2px 0 var(--c-gold-edge)) drop-shadow(0 8px 22px rgb(244 197 66 / 0.28))",
                }}
                {...rise(0.12)}
              >
                {cfg.title}
              </motion.h2>
              {/* fio do verbete: desenha do centro para as pontas */}
              <div
                aria-hidden
                className="relative mt-3 flex h-3 w-52 items-center justify-center"
              >
                <motion.span
                  className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-[var(--c-gold)] to-transparent"
                  initial={{ scaleX: 0, opacity: reduce ? 0 : 1 }}
                  animate={{ scaleX: 1, opacity: 1 }}
                  transition={{
                    delay: reduce ? 0 : 0.2,
                    duration: reduce ? 0.2 : 0.6,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                />
                <motion.span
                  className="relative h-2 w-2 rotate-45 bg-[var(--c-gold)] shadow-[0_0_10px_rgb(244_197_66/0.8)]"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={
                    reduce
                      ? { duration: 0.2 }
                      : {
                          delay: 0.28,
                          type: "spring",
                          stiffness: 420,
                          damping: 14,
                        }
                  }
                />
              </div>
              <motion.p
                className="mt-3 text-sm text-muted-foreground font-display text-balance"
                {...rise(0.3, 6)}
              >
                {cfg.hint}
              </motion.p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
});
