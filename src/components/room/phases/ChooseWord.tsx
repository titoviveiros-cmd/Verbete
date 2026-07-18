import { useState } from "react";
import { motion } from "framer-motion";
import { fetchThreeWords, chooseWord, type Player, type Room, type Word } from "@/lib/room";
import { Mascot } from "@/components/Mascot";
import { playUITap } from "@/lib/sound";

export function ChooseWord({ room, players, isCoordinator }: {
  room: Room; players: Player[]; isCoordinator: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "flipping" | "ready">("idle");
  const [words, setWords] = useState<Word[] | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const coord = players.find((p) => p.id === room.current_coordinator);

  const handleDraw = async () => {
    if (phase !== "idle") return;
    setPhase("flipping");
    const [drawn] = await Promise.all([
      fetchThreeWords(room.used_word_ids ?? [], room.categories ?? [], room.id, room.nivel ?? "aleatorio"),
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
      await chooseWord(room.id, wordId, 60);
    } catch (e) {
      console.error("chooseWord failed", e);
      setPicking(null);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col items-center justify-center gap-3">
      {phase !== "ready" && <Mascot mood="thinking" size={140} />}
      <div className="text-center">
        <p className="text-muted-foreground text-xs font-display">Coordenador da rodada</p>
        <h2 className={"font-display text-sun " + (phase === "ready" ? "text-xl" : "text-3xl mt-1")}>{coord?.nickname} 👑</h2>
      </div>

      {isCoordinator ? (
        <div className="w-full flex flex-col items-center gap-4">
          {phase === "idle" && (
            <motion.button
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleDraw}
              className="btn-pop bg-gradient-fun text-white text-2xl px-8 py-5"
            >
              📖 Sortear palavra
            </motion.button>
          )}

          {phase === "flipping" && <DictionaryFlip />}

          {phase === "ready" && words && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full space-y-2"
            >
              <p className="text-center font-display text-pink animate-pulse text-sm">
                {picking ? "Confirmando palavra…" : "Escolha uma palavra rara!"}
              </p>
              {words.map((w, i) => (
                <motion.button
                  key={w.id}
                  initial={{ scale: 0.6, opacity: 0, rotate: -3 }}
                  animate={{ scale: 1, opacity: 1, rotate: 0 }}
                  transition={{ delay: i * 0.1, type: "spring", stiffness: 220 }}
                  whileTap={{ scale: 0.96 }}
                  disabled={!!picking}
                  onClick={() => handlePick(w.id)}
                  onCopy={(e) => e.preventDefault()}
                  onContextMenu={(e) => e.preventDefault()}
                  className={
                    "w-full sticker text-left transition px-3 py-2 flex items-baseline gap-2 no-copy " +
                    (picking && picking !== w.id ? "opacity-40 pointer-events-none " : "active:bg-pink/10 ") +
                    (picking === w.id ? "ring-2 ring-pink " : "")
                  }
                >
                  <p className="font-display text-lg leading-tight flex-1 truncate capitalize">{w.word}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">{w.category}</p>
                </motion.button>
              ))}
            </motion.div>
          )}
        </div>
      ) : (
        <p className="text-center text-muted-foreground italic">Aguardando o coordenador escolher uma palavra…</p>
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
      <p className="font-display text-pink animate-pulse">Folheando o dicionário…</p>
    </div>
  );
}

export default ChooseWord;


