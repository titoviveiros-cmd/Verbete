import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { playCountdownTick, playCountdownFinal } from "@/lib/sound";
import type { Word, Player } from "@/lib/room";

export function WordCard({ word, compact = false }: { word: Word; compact?: boolean }) {
  return (
    <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 220 }}
      onCopy={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      className="sticker bg-gradient-fun text-center py-2 no-copy">
      <p className="text-[10px] uppercase tracking-widest font-display opacity-80 leading-tight">A palavra é</p>
      <h2 className={"font-display text-stroke capitalize " + (compact ? "text-2xl" : "text-3xl") + " text-white mt-0.5 leading-tight"}>
        {word.word}
      </h2>
    </motion.div>
  );
}

export function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  return (
    <div className="w-full">
      <div className="h-3 bg-card rounded-full overflow-hidden border border-white/10">
        <motion.div className="h-full bg-gradient-fun"
          initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ type: "spring" }} />
      </div>
      <p className="text-xs text-center text-muted-foreground mt-1">{current}/{total}</p>
    </div>
  );
}

export function PendingList({ pending }: { pending: Player[] }) {
  if (!pending || pending.length === 0) {
    return <p className="text-xs text-mint font-display">✨ todos enviaram!</p>;
  }
  return (
    <div className="w-full flex flex-col items-center gap-2">
      <p className="text-xs text-muted-foreground font-display uppercase tracking-wider">
        faltam {pending.length}:
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {pending.map((p) => (
          <motion.div key={p.id}
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 1.6, repeat: Infinity }}
            className="flex items-center gap-1 bg-card border border-white/10 rounded-full pl-1 pr-3 py-1">
            <span className="text-lg">{p.avatar}</span>
            <span className="font-display text-sm">{p.nickname}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export function TimerBar({ remaining, max, tickStartAt = 5 }: { remaining: number; max: number; tickStartAt?: number }) {
  const pct = (remaining / max) * 100;
  const urgent = remaining <= 10;
  const color = urgent ? "bg-destructive" : "bg-sun";
  const lastPlayed = useRef<string | null>(null);
  useEffect(() => {
    const key = `${max}:${tickStartAt}:${remaining}`;
    if (lastPlayed.current === key) return;
    lastPlayed.current = key;
    if (remaining > 0 && remaining <= tickStartAt) void playCountdownTick(remaining);
    else if (remaining === 0) void playCountdownFinal();
  }, [remaining, max, tickStartAt]);
  return (
    <div className="w-full flex flex-col items-center gap-1">
      <motion.div
        key={remaining}
        initial={urgent ? { scale: 1.2 } : { scale: 1 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.25 }}
        className={
          "font-display leading-none tracking-tight tabular-nums " +
          (urgent ? "text-destructive text-5xl drop-shadow-[0_0_12px_rgba(255,80,80,0.45)]" : "text-sun text-5xl")
        }
        aria-live="polite"
      >
        {remaining}
        <span className="text-xl ml-1 align-top opacity-70">s</span>
      </motion.div>
      <div className="h-2 w-full bg-card rounded-full overflow-hidden border border-white/10">
        <motion.div className={"h-full " + color} animate={{ width: `${pct}%` }} transition={{ duration: 0.5, ease: "linear" }} />
      </div>
    </div>
  );
}


