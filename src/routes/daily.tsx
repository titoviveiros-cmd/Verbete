import { APP_URL } from "@/lib/app-url";
import {
  createFileRoute,
  Link,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { Mascot } from "@/components/Mascot";
import {
  fetchDailyChallenge,
  fetchTodayAttempt,
  fetchDailyLeaderboard,
  fetchAllAchievements,
  msUntilNextChallenge,
  formatHMS,
  type DailyChallenge,
  type DailyReview,
} from "@/lib/daily";
import { submitDailyAttempt } from "@/lib/daily.functions";
import { burst, fireworks } from "@/lib/confetti";
import { pushAchievement } from "@/components/AchievementToaster";
import { TimerBar } from "@/components/room/shared";

const DAILY_TIME_LIMIT = 60;

export const Route = createFileRoute("/daily")({
  head: () => ({
    meta: [
      { title: "Desafio Diário — Verbete" },
      {
        name: "description",
        content:
          "Uma nova palavra rara a cada dia. Acerte o significado, mantenha sua streak e suba no ranking.",
      },
      { property: "og:title", content: "Desafio Diário — Verbete" },
      {
        property: "og:description",
        content: "Uma palavra rara por dia. Mantenha sua streak 🔥",
      },
      { property: "og:url", content: `${APP_URL}/daily` },
    ],
    links: [{ rel: "canonical", href: `${APP_URL}/daily` }],
  }),
  component: DailyPage,
});

function DailyPage() {
  const nav = useNavigate();
  const search = useSearch({ strict: false }) as { from?: string };
  const fromProfile = search.from === "profile";
  const { user, loading } = useAuth();
  const submit = useServerFn(submitDailyAttempt);

  const [data, setData] = useState<DailyChallenge | null>(null);
  const [review, setReview] = useState<DailyReview | null>(null);
  const [board, setBoard] = useState<
    Awaited<ReturnType<typeof fetchDailyLeaderboard>>
  >([]);
  const [achMap, setAchMap] = useState<
    Map<string, Awaited<ReturnType<typeof fetchAllAchievements>>[number]>
  >(new Map());
  const [guess, setGuess] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    correct: boolean;
    score: number;
    truth: string;
    similarity: number;
    guess: string;
    timeSeconds: number;
    streak?: number;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => msUntilNextChallenge());
  const [startedAt] = useState(() => Date.now());

  useEffect(() => {
    if (loading) return;
    if (!user) {
      nav({ to: "/login" });
      return;
    }
    (async () => {
      const [ch, my, lb, ach] = await Promise.all([
        fetchDailyChallenge(),
        fetchTodayAttempt(user.id),
        fetchDailyLeaderboard(),
        fetchAllAchievements(),
      ]);
      setData(ch);
      setReview(my);
      setBoard(lb);
      setAchMap(new Map(ach.map((a) => [a.code, a])));
    })();
  }, [user, loading, nav]);

  useEffect(() => {
    const iv = setInterval(() => setNowMs(msUntilNextChallenge()), 1000);
    return () => clearInterval(iv);
  }, []);

  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setTickNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, []);
  const remaining = Math.max(
    0,
    DAILY_TIME_LIMIT - Math.floor((tickNow - startedAt) / 1000),
  );
  const expired = remaining === 0;

  const onSubmit = async () => {
    if (busy) return;
    if (!guess.trim() && !expired) return;
    setBusy(true);
    try {
      const timeSeconds = Math.min(
        600,
        Math.round((Date.now() - startedAt) / 1000),
      );
      const submittedGuess = guess.trim();
      const res = await submit({
        data: { guess: submittedGuess, timeSeconds },
      });
      if (res.already_played) {
        // Re-fetch review (already played in another tab / earlier)
        const fresh = await fetchTodayAttempt(user!.id);
        setReview(fresh);
      } else {
        setResult({
          correct: !!res.is_correct,
          score: res.score ?? 0,
          truth: res.truth ?? "",
          similarity: (res as any).similarity ?? 0,
          guess: submittedGuess,
          timeSeconds,
          streak: res.current_streak,
        });
        if (res.is_correct) burst({ particleCount: 120, spread: 90 });
        if ((res.current_streak ?? 0) >= 7) fireworks();
        (res.unlocked ?? []).forEach((code) => {
          const a = achMap.get(code);
          if (a) pushAchievement(a);
        });
        const [lb, fresh] = await Promise.all([
          fetchDailyLeaderboard(),
          fetchTodayAttempt(user!.id),
        ]);
        setBoard(lb);
        setReview(fresh);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const playedAttempt = review?.played ? review.attempt : undefined;
  const alreadyDone = !!playedAttempt || !!result;

  useEffect(() => {
    if (expired && !alreadyDone && !busy) {
      onSubmit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired, alreadyDone, busy]);

  const displayResult = useMemo(() => {
    if (result) return result;
    if (playedAttempt)
      return {
        correct: playedAttempt.is_correct,
        score: playedAttempt.score,
        truth: review?.truth ?? "",
        similarity: playedAttempt.similarity ?? 0,
        guess: playedAttempt.guess,
        timeSeconds: playedAttempt.time_seconds ?? 0,
        streak: undefined as number | undefined,
      };
    return null;
  }, [result, playedAttempt, review]);

  if (loading || !data) {
    return (
      <div className="mobile-shell items-center justify-center">
        <Mascot mood="thinking" />
      </div>
    );
  }

  return (
    <div className="mobile-shell pt-4 gap-4 overflow-y-auto pb-8">
      <div className="flex items-center justify-between">
        <Link
          to={fromProfile ? "/profile" : "/"}
          className="btn-pop bg-card text-xs px-3 py-2 font-display flex items-center gap-1"
        >
          <span>←</span> {fromProfile ? "Voltar" : "Início"}
        </Link>
        <div className="flex flex-col items-end gap-0.5 rounded-2xl px-3 py-1.5 bg-card shadow-pop border border-pink/30">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-display leading-none">
            ⏳ Próximo desafio
          </span>
          <span
            className="font-display text-lg leading-none tabular-nums"
            style={{
              background: "var(--gradient-fun)",
              WebkitBackgroundClip: "text",
              color: "transparent",
            }}
          >
            {formatHMS(nowMs)}
          </span>
        </div>
      </div>

      <div
        className="text-center no-copy"
        onCopy={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground font-display">
          Desafio Diário
        </p>
        <motion.h1
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="font-display text-5xl mt-1 leading-[1.15] pb-2"
          style={{
            background: "var(--gradient-fun)",
            WebkitBackgroundClip: "text",
            color: "transparent",
          }}
        >
          {data.word.word}
        </motion.h1>
        {data.word.category && (
          <p className="text-xs text-muted-foreground mt-1">
            {data.word.category}
          </p>
        )}
      </div>

      <AnimatePresence mode="wait">
        {!alreadyDone ? (
          <motion.div
            key="form"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-3"
          >
            <TimerBar
              remaining={remaining}
              max={DAILY_TIME_LIMIT}
              tickStartAt={10}
            />
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-display">
              Qual o significado?
            </label>
            <textarea
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!busy && guess.trim()) onSubmit();
                }
              }}
              placeholder="Arrisque sua definição em poucas palavras... (Enter envia, Shift+Enter quebra linha)"
              maxLength={200}
              rows={3}
              className="bg-input rounded-2xl px-4 py-3 text-base border border-white/10 outline-none focus:ring-4 focus:ring-pink/40 resize-none"
            />
            <button
              onClick={onSubmit}
              disabled={busy || !guess.trim()}
              className="btn-pop bg-gradient-fun text-white text-xl py-4 disabled:opacity-50"
            >
              {busy ? "Enviando..." : "Enviar palpite 🎯"}
            </button>
            <p className="text-[11px] text-muted-foreground text-center">
              Quanto mais rápido acertar, mais pontos. Um palpite por hora!
            </p>
          </motion.div>
        ) : (
          <motion.div
            key="result"
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className={
              "sticker py-5 px-4 text-center " +
              (displayResult?.correct ? "bg-mint/20 border-mint" : "")
            }
          >
            <p className="text-4xl mb-1">
              {displayResult?.correct ? "🎉" : "🤔"}
            </p>
            <p className="font-display text-xl">
              {displayResult?.correct ? "Acertou!" : "Não foi dessa vez"}
            </p>
            <p className="font-display text-3xl text-primary mt-1">
              +{displayResult?.score ?? 0} pts
            </p>

            {displayResult && (
              <div className="mt-3 text-[11px] text-muted-foreground bg-white/50 rounded-2xl px-3 py-2 border border-white/40 text-left">
                <p className="font-display uppercase tracking-wider text-[10px] mb-1 text-center">
                  Como calculamos
                </p>
                {displayResult.correct ? (
                  <>
                    <p>
                      base = máx(100 − <b>{displayResult.timeSeconds}s</b>, 20)
                      = <b>{Math.max(100 - displayResult.timeSeconds, 20)}</b>
                    </p>
                    <p>
                      pts = arred(base × <b>{displayResult.similarity}%</b>)
                      mín. 20 = <b>{displayResult.score}</b>
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      Sua semelhança foi <b>{displayResult.similarity}%</b>,
                      abaixo do mínimo de <b>80%</b> para pontuar.
                    </p>
                    <p className="mt-1 opacity-80">
                      Se tivesse atingido 80%+: base = máx(100 −{" "}
                      <b>{displayResult.timeSeconds}s</b>, 20) ={" "}
                      <b>{Math.max(100 - displayResult.timeSeconds, 20)}</b>,
                      depois multiplicada pela semelhança (mín. 20 pts).
                    </p>
                  </>
                )}
              </div>
            )}

            {typeof displayResult?.similarity === "number" && (
              <div className="mt-4">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-muted-foreground font-display mb-1">
                  <span>Semelhança</span>
                  <span
                    className={
                      displayResult.correct ? "text-mint" : "text-pink"
                    }
                  >
                    {displayResult.similarity}%{" "}
                    {displayResult.correct ? "✓" : "(min. 80%)"}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-white/40 overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{
                      width: `${Math.min(100, displayResult.similarity)}%`,
                    }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                    className={
                      "h-full " +
                      (displayResult.correct ? "bg-mint" : "bg-gradient-fun")
                    }
                  />
                </div>
              </div>
            )}

            {displayResult?.guess && (
              <div className="mt-4 text-left bg-white/60 rounded-2xl p-3 border border-white/40">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-display mb-1">
                  Seu palpite
                </p>
                <p className="text-sm">"{displayResult.guess}"</p>
              </div>
            )}
            {displayResult?.truth && (
              <div className="mt-2 text-left bg-mint/15 rounded-2xl p-3 border border-mint/40">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-display mb-1">
                  Significado correto
                </p>
                <p className="text-sm italic">"{displayResult.truth}"</p>
              </div>
            )}

            {result?.streak && (
              <p className="font-display text-sm text-sun mt-3">
                🔥 Streak: {result.streak} dia{result.streak > 1 ? "s" : ""}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div>
        <h2 className="font-display text-lg mb-2">🏆 Ranking de hoje</h2>
        {board.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">
            Seja o primeiro a jogar hoje!
          </p>
        ) : (
          <ul className="space-y-1.5">
            {board.map((row, i) => (
              <li
                key={row.user_id}
                className="sticker py-2 px-3 flex items-center gap-2 text-sm"
              >
                <span className="font-display w-6 text-center text-sun">
                  {i + 1}
                </span>
                <span className="text-xl">{row.profile?.avatar ?? "🦊"}</span>
                <span className="flex-1 truncate">
                  {row.profile?.display_name ?? "Jogador"}
                </span>
                {row.is_correct ? (
                  <span className="text-mint text-xs">✓</span>
                ) : (
                  <span className="text-muted-foreground text-xs">✗</span>
                )}
                <span className="font-display text-primary">{row.score}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
