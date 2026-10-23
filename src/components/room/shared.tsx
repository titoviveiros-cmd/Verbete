import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { playCountdownTick, playCountdownFinal, hapticTick } from "@/lib/sound";
import type { Word, Player } from "@/lib/room";

export function WordCard({
  word,
  compact = false,
}: {
  word: Word;
  compact?: boolean;
}) {
  return (
    <motion.div
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 220 }}
      onCopy={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      className={
        "word-hero text-center no-copy " +
        (compact ? "px-4 py-2" : "px-4 py-3 lg:py-5")
      }
    >
      <p className="eyebrow !text-white/85 leading-tight">A palavra é</p>
      <h2
        className={
          "font-display text-stroke capitalize text-white mt-0.5 leading-tight " +
          (compact ? "text-2xl" : "text-[34px] lg:text-[46px]")
        }
      >
        {word.word}
      </h2>
    </motion.div>
  );
}

export function ProgressBar({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  return (
    <div className="w-full">
      <div className="meter h-3">
        <motion.div
          className="h-full rounded-full meter-fill-turq"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring" }}
        />
      </div>
      <p className="text-xs text-center text-muted-foreground mt-1 font-bold tabular-nums">
        {current}/{total}
      </p>
    </div>
  );
}

/** "Falta: 🐰 MestreLero" / "Faltam: 🐰 MestreLero · 🦄 Raiza". */
export function pendingSentence(pending: Player[]): string {
  const who = pending.map((p) => `${p.avatar} ${p.nickname}`).join(" · ");
  return `${pending.length === 1 ? "Falta" : "Faltam"}: ${who}`;
}

/** "🤖 Dona Lupa está preparando a definição…" (um ou vários bots). */
export function botsPreparingSentence(bots: Player[]): string {
  if (bots.length === 1)
    return `🤖 ${bots[0]!.nickname} está preparando a definição…`;
  const names = bots.map((b) => b.nickname);
  const last = names.pop();
  return `🤖 ${names.join(", ")} e ${last} estão preparando as definições…`;
}

// Quem falta, pelo nome e numa frase só (playtest 2026-10-20: aparecia só
// "FALTAM 1:" e os nomes, em chips abaixo, caíam para fora da tela). Bots
// que ainda não enviaram aparecem à parte e discretos — a lista vem das
// definições reais, então quem já enviou nunca aparece "preparando".
export function PendingList({ pending }: { pending: Player[] }) {
  if (!pending || pending.length === 0) {
    return <p className="text-sm text-mint font-display">✨ todos enviaram!</p>;
  }
  const humans = pending.filter((p) => !p.is_bot);
  const bots = pending.filter((p) => p.is_bot);
  return (
    <div className="w-full flex flex-col items-center gap-1 text-center">
      {humans.length > 0 && (
        <p className="font-display text-sm leading-snug">
          {pendingSentence(humans)}
        </p>
      )}
      {bots.length > 0 && (
        <p className="text-xs text-muted-foreground font-display leading-snug">
          {botsPreparingSentence(bots)}
        </p>
      )}
    </div>
  );
}

export function TimerBar({
  remaining,
  max,
  tickStartAt = 5,
}: {
  remaining: number;
  max: number;
  tickStartAt?: number;
}) {
  const pct = (remaining / max) * 100;
  const urgent = remaining <= 10;
  const color = urgent ? "meter-fill-urgent" : "meter-fill-gold";
  // Fase 7: leitor de tela ouve só marcos (10s e 3s), não cada segundo.
  const srAnnouncement =
    remaining === 10
      ? "10 segundos restantes"
      : remaining === 3
        ? "3 segundos restantes"
        : "";
  const lastPlayed = useRef<string | null>(null);
  useEffect(() => {
    const key = `${max}:${tickStartAt}:${remaining}`;
    if (lastPlayed.current === key) return;
    lastPlayed.current = key;
    if (remaining > 0 && remaining <= tickStartAt) {
      void playCountdownTick(remaining);
      // Fase 5: tato acompanha o som nos 3 segundos finais
      if (remaining <= 3) hapticTick();
    } else if (remaining === 0) void playCountdownFinal();
  }, [remaining, max, tickStartAt]);
  return (
    <div className="w-full flex flex-col items-center gap-1">
      <motion.div
        key={remaining}
        initial={urgent ? { scale: 1.2 } : { scale: 1 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.25 }}
        className={
          "font-display leading-none tracking-tight tabular-nums text-5xl " +
          (urgent
            ? "text-destructive drop-shadow-[0_0_14px_rgba(255,80,80,0.5)]"
            : "text-sun drop-shadow-[0_0_14px_rgba(244,197,66,0.35)]")
        }
        role="timer"
      >
        {remaining}
        <span className="text-xl ml-1 align-top opacity-70">s</span>
      </motion.div>
      <span className="sr-only" aria-live="polite">
        {srAnnouncement}
      </span>
      <div className="meter h-2.5 w-full">
        <motion.div
          className={"h-full rounded-full " + color}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: "linear" }}
        />
      </div>
    </div>
  );
}
