import { useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { startVoting, type Definition, type Room, type Word } from "@/lib/room";
import { playCardShuffle } from "@/lib/sound";
import { VerbeteTile } from "@/components/VerbeteLogo";

export function Shuffling({
  room,
  word,
  definitions,
  isHost,
}: {
  room: Room;
  word: Word;
  definitions: Definition[];
  isHost: boolean;
}) {
  useEffect(() => {
    void playCardShuffle();
    // O host dispara rápido (400ms). Demais clientes têm fallback de segurança
    // após 2s, caso o host não responda. `startVoting` é idempotente.
    const delay = isHost ? 400 : 2000;
    const t = setTimeout(
      () => startVoting(room.id, room.current_round, word, definitions),
      delay,
    );
    return () => clearTimeout(t);
  }, [room.id, room.current_round, word, definitions, isHost]);

  // Pré-carrega o chunk de Voting durante a animação para entrar instantâneo
  useEffect(() => {
    void import("@/components/room/phases/Voting");
  }, []);

  const cards = useMemo(() => [0, 1, 2, 3, 4], []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="flex-1 flex flex-col items-center justify-center gap-10 overflow-hidden w-full max-w-full px-4"
    >
      <motion.p
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.05, duration: 0.35 }}
        className="font-display text-lg sm:text-xl text-center uppercase tracking-[0.25em] opacity-80"
      >
        Embaralhando as cédulas
      </motion.p>

      {/* Leque de cartas — abertura suave e reagrupamento */}
      <div className="relative h-44 w-full max-w-[260px] mx-auto" aria-hidden>
        {cards.map((i) => {
          const fanAngle = (i - 2) * 12;
          const fanX = (i - 2) * 20;
          return (
            <motion.div
              key={i}
              className="absolute left-1/2 top-1/2 w-24 h-36 rounded-2xl bg-gradient-fun shadow-pop border-2 border-white/15"
              style={{
                marginLeft: -48,
                marginTop: -72,
                transformOrigin: "50% 100%",
              }}
              initial={{ x: 0, y: 0, rotate: 0, scale: 0.92, opacity: 0 }}
              animate={{
                x: [0, fanX, fanX, 0],
                y: [0, -6, -2, 0],
                rotate: [0, fanAngle, fanAngle, 0],
                scale: [0.92, 1, 1, 0.96],
                opacity: [0, 1, 1, 1],
              }}
              transition={{
                duration: 1.2,
                times: [0, 0.35, 0.7, 1],
                ease: [0.22, 1, 0.36, 1],
                delay: i * 0.06,
              }}
            >
              {/* Fase 3: verso da cédula com a marca oficial (diretriz
                  2026-07-19) — antes era o ícone genérico do app. */}
              <div className="h-full w-full rounded-2xl flex items-center justify-center">
                <VerbeteTile size={56} glow={false} />
              </div>
            </motion.div>
          );
        })}

        {/* glow de fundo */}
        <motion.div
          aria-hidden
          className="absolute inset-0 -z-10 rounded-full"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: [0, 0.55, 0.3], scale: [0.6, 1.15, 1] }}
          transition={{ duration: 1.1, ease: "easeOut" }}
          style={{
            background:
              "radial-gradient(closest-side, color-mix(in oklab, var(--pink) 35%, transparent), transparent 70%)",
            filter: "blur(22px)",
          }}
        />
      </div>

      {/* três pontinhos pulsantes — mais simples que barra de progresso */}
      <div className="flex items-center gap-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="w-2 h-2 rounded-full bg-foreground/60"
            animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
            transition={{
              duration: 1.1,
              repeat: Infinity,
              delay: i * 0.18,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.35 }}
        className="font-display text-sm text-muted-foreground text-center"
      >
        Preparando a votação…
      </motion.p>
    </motion.div>
  );
}

export default Shuffling;
