import { useState } from "react";
import { motion } from "framer-motion";
import {
  fetchThreeWords,
  chooseWord,
  type Player,
  type Room,
  type Word,
} from "@/lib/room";
import { Mascot } from "@/components/Mascot";
import { playUITap } from "@/lib/sound";

export function ChooseWord({
  room,
  players,
  isCoordinator,
}: {
  room: Room;
  players: Player[];
  isCoordinator: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "flipping" | "ready">("idle");
  const [words, setWords] = useState<Word[] | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const coord = players.find((p) => p.id === room.current_coordinator);

  const handleDraw = async () => {
    if (phase !== "idle") return;
    setPhase("flipping");
    const [drawn] = await Promise.all([
      fetchThreeWords(
        room.used_word_ids ?? [],
        room.categories ?? [],
        room.id,
        room.nivel ?? "aleatorio",
      ),
      new Promise((r) => setTimeout(r, 1800)),
    ]);
    setWords(drawn);
    setPhase("ready");
  };

  const handlePick = async (wordId: string) => {
    if (picking) return;
    setPicking(wordId);
    void playUITap();
    try {
      await chooseWord(room.id, wordId, 60, players.length);
    } catch (e) {
      console.error("chooseWord failed", e);
      setPicking(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex-1 flex flex-col items-center justify-center gap-4 lg:gap-6"
    >
      {phase !== "ready" && (
        <div className="relative short:hidden">
          <div
            aria-hidden
            className="absolute -inset-8 rounded-full pointer-events-none"
            style={{
              background:
                "radial-gradient(circle, rgb(155 108 255 / 0.35) 0%, transparent 70%)",
              filter: "blur(16px)",
            }}
          />
          <Mascot mood="thinking" size={140} className="relative" />
        </div>
      )}
      <div className="text-center flex flex-col items-center">
        <p className="eyebrow">Coordenador da rodada</p>
        <div className="flex items-center gap-2.5 mt-1.5">
          {coord && (
            <span
              aria-hidden
              className={
                "rounded-full flex items-center justify-center shrink-0 " +
                (phase === "ready" ? "w-9 h-9 text-lg" : "w-12 h-12 text-2xl")
              }
              style={{
                background: `radial-gradient(circle at 30% 25%, ${coord.color}cc, ${coord.color})`,
                boxShadow:
                  "0 0 0 2px rgb(244 197 66 / 0.9), 0 4px 0 rgb(0 0 0 / 0.35)",
              }}
            >
              {coord.avatar}
            </span>
          )}
          <h2
            className={
              "font-display text-gold-grad leading-none " +
              (phase === "ready" ? "text-3xl" : "text-[42px] short:text-3xl")
            }
          >
            {coord?.nickname}
          </h2>
          <span
            aria-hidden
            className={phase === "ready" ? "text-2xl" : "text-3xl"}
          >
            👑
          </span>
        </div>
      </div>

      {isCoordinator ? (
        <div className="w-full flex flex-col items-center gap-4">
          {phase === "idle" && (
            <motion.button
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleDraw}
              className="btn-pop btn-gold text-2xl px-9 py-5"
            >
              📖 Sortear palavra
            </motion.button>
          )}

          {phase === "flipping" && <DictionaryFlip />}

          {phase === "ready" && words && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full flex flex-col gap-3"
            >
              <p className="text-center font-display text-pink text-xl">
                {picking ? "Confirmando palavra…" : "Escolha uma palavra rara!"}
              </p>
              <div className="flex flex-col gap-3 lg:grid lg:grid-cols-3">
                {words.map((w, i) => (
                  <motion.button
                    key={w.id}
                    initial={{ scale: 0.6, opacity: 0, rotate: -3 }}
                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                    transition={{
                      delay: i * 0.1,
                      type: "spring",
                      stiffness: 220,
                    }}
                    whileTap={{ scale: 0.96 }}
                    disabled={!!picking}
                    onClick={() => handlePick(w.id)}
                    onCopy={(e) => e.preventDefault()}
                    onContextMenu={(e) => e.preventDefault()}
                    className={
                      "w-full sticker text-left transition !px-4 !py-3 flex items-center gap-3 no-copy lg:flex-col lg:items-start lg:!py-5 " +
                      (picking && picking !== w.id
                        ? "opacity-40 pointer-events-none "
                        : "") +
                      (picking === w.id ? "ring-neon " : "")
                    }
                  >
                    <span
                      aria-hidden
                      className="text-2xl lg:text-3xl leading-none"
                    >
                      📖
                    </span>
                    <p className="font-display text-[22px] lg:text-[26px] leading-tight flex-1 min-w-0 truncate capitalize">
                      {w.word}
                    </p>
                    {w.category && (
                      <span className="chip text-muted-foreground uppercase tracking-wider !text-[10px] shrink-0">
                        {w.category}
                      </span>
                    )}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      ) : (
        <div className="panel px-5 py-4 text-center flex flex-col items-center gap-2">
          <p className="font-display text-lg">
            {coord?.nickname ?? "O coordenador"} está escolhendo a palavra…
          </p>
          <div className="flex items-center gap-1.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="w-2 h-2 rounded-full bg-sun"
                animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
                transition={{
                  duration: 1.1,
                  repeat: Infinity,
                  delay: i * 0.18,
                }}
              />
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function DictionaryFlip() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative"
        style={{ width: 220, height: 150, perspective: "1200px" }}
        aria-label="Dicionário sendo folheado"
      >
        <div className="absolute inset-0 rounded-r-md rounded-l-sm bg-gradient-to-r from-[#4a2a14] via-[#6b3a1c] to-[#4a2a14] shadow-pop" />
        <div className="absolute inset-y-2 inset-x-2 rounded-sm bg-[#fdf6e3]" />
        <div className="absolute inset-y-2 left-1/2 -ml-px w-0.5 bg-black/20" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <motion.div
            key={i}
            className="absolute top-2 bottom-2 right-2 w-[calc(50%-6px)] rounded-sm bg-[#fdf6e3] shadow-md"
            style={{
              transformOrigin: "left center",
              backfaceVisibility: "hidden",
              backgroundImage:
                "repeating-linear-gradient(transparent 0 10px, rgba(0,0,0,0.06) 10px 11px)",
            }}
            initial={{ rotateY: 0 }}
            animate={{ rotateY: -170 }}
            transition={{
              duration: 0.55,
              ease: "easeIn",
              delay: i * 0.18,
              repeat: Infinity,
              repeatDelay: 6 - i * 0.18,
            }}
          />
        ))}
      </div>
      <p className="font-display text-lg text-pink animate-pulse">
        Folheando o dicionário…
      </p>
    </div>
  );
}

export default ChooseWord;
