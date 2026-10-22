import { useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { startVoting, type Definition, type Room, type Word } from "@/lib/room";
import { playCardShuffle } from "@/lib/sound";
import { VerbeteTile } from "@/components/VerbeteLogo";

// Embaralhar é tempo dramático: as cédulas abrem em leque e são embaralhadas
// por ~2 s antes de a votação abrir. Antes o host abria a votação em 0,4 s e
// a tela passava rápido demais: 0,7–1,7 s medidos numa partida real, o
// convidado às vezes só via 0,7 s (playtest 2026-10-20). Calibrado pela
// medição: a tela fica o hold + ~0,4–1,0 s (RPC, tempo real e a saída
// animada; o convidado recebe a fase um pouco depois do host) — com 1,8 s
// ficava 2,4–3,2 s; com 1,2 s, host 2,0–2,2 s e convidado 1,6–1,7 s; com
// 1,4 s, os dois na faixa pedida em 2026-10-20 (1,8–2,5 s). Regra de
// 2026-10-22 (tela narrativa ≥ 2,5 s): com 1,4 s a prévia mediu host
// 2,15–2,49 s e convidado 2,13–2,55 s (hold + 0,73–1,15 s), abaixo do
// mínimo; com 2,0 s, 2,73–3,15 s nos dois. O prazo da
// votação é do servidor e só começa quando ela abre (advance_writing_to_
// voting), igual para todos; os convidados só cobrem a falta do host.
export const SHUFFLE_HOLD_MS = 2000;
export const SHUFFLE_GUEST_FALLBACK_MS = SHUFFLE_HOLD_MS + 1800;
// Um ciclo completo da coreografia (leque → troca → monte) cabe no tempo
// em que a tela fica visível (o hold + a ida e volta da votação ao banco).
const SHUFFLE_CYCLE_S = 1.8;

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
  // Palavra e cédulas pelo ref: o poll de get_round_sync troca a identidade
  // de `definitions` a cada ~0,7 s, e com elas nas dependências o efeito
  // recomeçava o relógio a cada poll — com 1,8 s o host nunca abriria a
  // votação; no código antigo (0,4 s) saíam startVoting e o som de
  // embaralhar repetidos (medição de 2026-10-20). O relógio conta UMA vez.
  const latest = useRef({ word, definitions });
  latest.current = { word, definitions };
  useEffect(() => {
    void playCardShuffle();
    // Só o host abre a votação; os demais cobrem se ele cair. `startVoting`
    // é idempotente (a RPC re-checa o estado sob lock de linha).
    const delay = isHost ? SHUFFLE_HOLD_MS : SHUFFLE_GUEST_FALLBACK_MS;
    const t = setTimeout(() => {
      const { word: w, definitions: d } = latest.current;
      void startVoting(room.id, room.current_round, w, d);
    }, delay);
    return () => clearTimeout(t);
  }, [room.id, room.current_round, isHost]);

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
      className="flex-1 flex flex-col items-center justify-center gap-8 short:gap-2 overflow-hidden w-full max-w-full px-4"
    >
      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.05, duration: 0.35 }}
        className="text-center"
      >
        <p className="eyebrow">Embaralhando as cédulas</p>
        <p className="font-display text-2xl lg:text-3xl mt-1 short:hidden">
          Qual delas é a verdade?
        </p>
      </motion.div>

      {/* Micro-evento: as cédulas abrem em leque e são embaralhadas
          enquanto a votação prepara (a fase dura ~2 s). */}
      <div
        className="relative h-48 w-full max-w-[320px] mx-auto short:h-36 short:scale-[0.78]"
        aria-hidden
      >
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
                duration: SHUFFLE_CYCLE_S,
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
