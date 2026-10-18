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

  // Uma carta por cédula (os blefes + a verdade), de 4 a 7 na mesa.
  const ballots = Math.min(7, Math.max(4, definitions.length + 1));
  const cards = useMemo(
    () => Array.from({ length: ballots }, (_, i) => i),
    [ballots],
  );
  const mid = (ballots - 1) / 2;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="flex-1 flex flex-col items-center justify-center gap-8 overflow-hidden w-full max-w-full px-4"
    >
      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.05, duration: 0.35 }}
        className="text-center"
      >
        <p className="eyebrow">Embaralhando as cédulas</p>
        <p className="font-display text-2xl lg:text-3xl mt-1">
          Qual delas é a verdade?
        </p>
      </motion.div>

      {/* Micro-evento: as cédulas abrem em leque e são embaralhadas em
          laço enquanto a votação prepara (a fase dura ~1–2 s). */}
      <div className="relative h-48 w-full max-w-[320px] mx-auto" aria-hidden>
        <motion.div
          aria-hidden
          className="absolute inset-0 -z-10 rounded-full"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: [0, 0.6, 0.35], scale: [0.6, 1.2, 1] }}
          transition={{ duration: 1.1, ease: "easeOut" }}
          style={{
            background:
              "radial-gradient(closest-side, var(--v-neon-glow), transparent 70%)",
            filter: "blur(22px)",
          }}
        />
        {cards.map((i) => {
          const off = i - mid;
          const fanAngle = off * 11;
          const fanX = off * 22;
          const swap = i % 2 === 0 ? 64 : -64;
          return (
            <motion.div
              key={i}
              className="card-back absolute left-1/2 top-1/2 w-24 h-36"
              style={{
                marginLeft: -48,
                marginTop: -72,
                transformOrigin: "50% 100%",
                zIndex: i,
              }}
              initial={{ x: 0, y: 0, rotate: 0, scale: 0.92, opacity: 0 }}
              animate={{
                x: [0, fanX, fanX, swap, 0],
                y: [0, -6, -2, -16, 0],
                rotate: [0, fanAngle, fanAngle, swap / 5, 0],
                scale: [0.92, 1, 1, 1.04, 0.98],
                opacity: [0, 1, 1, 1, 1],
              }}
              transition={{
                duration: 2.2,
                times: [0, 0.25, 0.5, 0.75, 1],
                ease: [0.22, 1, 0.36, 1],
                delay: i * 0.05,
                repeat: Infinity,
                repeatDelay: 0.15,
              }}
            >
              {/* Fase 3: verso da cédula com a marca oficial (diretriz
                  2026-07-19) — antes era o ícone genérico do app. */}
              <div className="h-full w-full flex items-center justify-center">
                <VerbeteTile size={50} glow={false} />
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-2">
        <span className="chip text-sm text-muted-foreground">
          🗳️ {ballots} cédulas na mesa
        </span>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          className="font-display text-sm text-muted-foreground text-center"
        >
          Preparando a votação…
        </motion.p>
      </div>
    </motion.div>
  );
}

export default Shuffling;
