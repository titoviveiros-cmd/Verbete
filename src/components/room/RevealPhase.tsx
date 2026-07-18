import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { goToScoreboard } from "@/lib/room";
import type { Definition, Player, Room, Vote, Word } from "@/lib/room";
import { Mascot } from "@/components/Mascot";
import { WordCard } from "./PhaseShared";
import { burst, sideCannons } from "@/lib/confetti";

export default function RevealPhase({ room, players, word, definitions, votes, isHost }: {


  room: Room; players: Player[]; word: Word; definitions: Definition[]; votes: Vote[]; isHost: boolean;
}) {
  const truth = definitions.find((d) => (d.player_id === "__truth__"));
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t1 = setTimeout(() => setStep(1), 1500);
    const t2 = setTimeout(() => setStep(2), 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // Confete na revelação da verdade + canhões laterais quando os votos chegam.
  useEffect(() => {
    if (step === 1) burst({ particleCount: 100, spread: 80 });
    if (step === 2) sideCannons();
  }, [step]);

  const REVEAL_HOLD = 15;
  const [revealCountdown, setRevealCountdown] = useState(REVEAL_HOLD);
  useEffect(() => {
    if (step < 2) return;
    setRevealCountdown(REVEAL_HOLD);
    const iv = setInterval(() => setRevealCountdown((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(iv);
  }, [step]);
  useEffect(() => {
    if (!isHost || step < 2) return;
    const t = setTimeout(() => goToScoreboard(room.id), REVEAL_HOLD * 1000);
    return () => clearTimeout(t);
  }, [isHost, step, room.id]);

  const ordered = [...definitions].sort((a, b) => (a.letter ?? "Z").localeCompare(b.letter ?? "Z"));

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col gap-4 pt-2">
      {step >= 2 && (
        <motion.div initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
          className="sticky top-0 z-30 -mx-4 px-4 py-2 bg-gradient-fun shadow-pop border-b-2 border-black/30 flex items-center justify-center gap-3">
          <span className="font-display text-sm uppercase tracking-wider text-white/90">📊 Placar em</span>
          <motion.span key={revealCountdown} initial={{ scale: 1.4 }} animate={{ scale: 1 }} transition={{ duration: 0.25 }}
            className="font-display text-4xl text-white tabular-nums drop-shadow">
            {revealCountdown}
          </motion.span>
          <span className="font-display text-sm text-white/90">s</span>
        </motion.div>
      )}
      <WordCard word={word} compact />

      {step < 1 && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Mascot mood="wow" size={130} />
          <p className="font-display text-2xl animate-pulse">Tãm tãm tãm…</p>
        </div>
      )}

      {step >= 1 && (
        <motion.div initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          className="sticker bg-gradient-mint text-accent-foreground text-center py-6">
          <p className="text-sm uppercase tracking-wider font-display">A definição verdadeira é…</p>
          <p className="font-display text-2xl mt-2 leading-snug">"{truth?.text}"</p>
        </motion.div>
      )}

      {step >= 2 && (
        <div className="space-y-2">
          {ordered.map((d) => {
            const author = players.find((p) => p.id === d.player_id);
            const dVoters = votes.filter((v) => v.definition_id === d.id);
            return (
              <motion.div key={d.id} initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
                className={"sticker " + ((d.player_id === "__truth__") ? "bg-mint/20 border-mint" : "")}>
                <div className="flex items-start gap-2">
                  <span className="font-display text-2xl text-sun">{d.letter}</span>
                  <div className="flex-1">
                    <p className="text-base leading-snug">{d.text}</p>
                    <div className="flex items-center gap-2 mt-2 text-xs">
                      {(d.player_id === "__truth__") ? (
                        <span className="text-mint font-display">✅ Verdade</span>
                      ) : author ? (
                        <span className="font-display flex items-center gap-1">
                          <span className="text-base">{author.avatar}</span>{author.nickname}
                        </span>
                      ) : null}
                      {dVoters.length > 0 && (
                        <span className="ml-auto text-pink font-display">
                          +{dVoters.length} voto{dVoters.length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}


