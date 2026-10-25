import { APP_URL } from "@/lib/app-url";
import { verbeteWordmarkStyle } from "@/components/VerbeteLogo";
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
import { ServerFnResponseError } from "@/lib/server-fn-transport";
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
  const [submitError, setSubmitError] = useState<string | null>(null);
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
    setSubmitError(null);
    try {
      const timeSeconds = Math.min(
        600,
        Math.round((Date.now() - startedAt) / 1000),
      );
      const submittedGuess = guess.trim();
      const res = await submit({
        data: { guess: submittedGuess, timeSeconds },
      });
      // tentativa só conta se o servidor devolveu o resultado de verdade
      if (
        !res ||
        typeof res !== "object" ||
        typeof res.already_played !== "boolean"
      )
        throw new ServerFnResponseError(
          "Não foi possível registrar a tentativa. Tente novamente.",
        );
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
      // Sem isto o envio automático do tempo esgotado repetia em laço.
      setSubmitError(
        e instanceof Error && e.message
          ? e.message
          : "Não foi possível enviar agora — tente de novo.",
      );
    } finally {
      setBusy(false);
    }
  };

  const playedAttempt = review?.played ? review.attempt : undefined;
  const alreadyDone = !!playedAttempt || !!result;

  useEffect(() => {
    if (expired && !alreadyDone && !busy && !submitError) {
      onSubmit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired, alreadyDone, busy, submitError]);

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

  const sim = Math.max(0, Math.min(100, displayResult?.similarity ?? 0));
  const myId = user?.id;

  return (
    <div className="mobile-shell stage-wide pt-4 gap-4 overflow-y-auto pb-8">
      <div className="flex items-center justify-between gap-3">
        <Link
          to={fromProfile ? "/profile" : "/"}
          className="btn-pop btn-plain text-sm px-3.5 py-2 font-display flex items-center gap-1"
        >
          <span>←</span> {fromProfile ? "Voltar" : "Início"}
        </Link>
        <div className="panel flex flex-col items-end gap-1 !rounded-2xl px-3 py-1.5">
          <span className="eyebrow !text-[10px] leading-none">
            ⏳ Próximo desafio
          </span>
          <span className="font-display text-lg leading-none tabular-nums text-sun">
            {formatHMS(nowMs)}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[1.15fr_0.85fr] lg:gap-8 lg:items-start lg:my-auto">
        <div className="flex flex-col gap-4 min-w-0">
          {/* A palavra do desafio como verbete de dicionário + o Livro */}
          <div
            className="relative no-copy"
            onCopy={(e) => e.preventDefault()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <motion.div
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 220, damping: 16 }}
              className="word-hero text-center px-5 pt-4 pb-5 lg:pt-6 lg:pb-7"
            >
              <p className="eyebrow !text-white/85">🎯 Desafio Diário</p>
              {/* Uniformização: palavra no tratamento canônico (branco + contorno) */}
              <h1
                className="font-display font-black mt-1 leading-[1.1] capitalize"
                style={verbeteWordmarkStyle("clamp(40px, 12vw, 64px)")}
              >
                {data.word.word}
              </h1>
              {data.word.category && (
                <span className="chip mt-2 !bg-white/15 !border-white/30 text-white/90 uppercase tracking-wider !text-[10px]">
                  {data.word.category}
                </span>
              )}
            </motion.div>
            {!displayResult && (
              <div className="absolute -right-2 -bottom-6 lg:-right-6 lg:-bottom-8 pointer-events-none">
                <Mascot mood="thinking" size={78} />
              </div>
            )}
          </div>

          <AnimatePresence mode="wait">
            {!alreadyDone ? (
              <motion.div
                key="form"
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-3 pt-3"
              >
                <TimerBar
                  remaining={remaining}
                  max={DAILY_TIME_LIMIT}
                  tickStartAt={10}
                />
                <label htmlFor="daily-guess" className="eyebrow px-1">
                  Qual o significado?
                </label>
                <textarea
                  id="daily-guess"
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
                  className="field px-4 py-3 text-base lg:text-lg resize-none"
                />
                <button
                  onClick={onSubmit}
                  disabled={busy || !guess.trim()}
                  className="btn-pop btn-gold text-xl py-4"
                >
                  {busy ? "Enviando..." : "Enviar palpite 🎯"}
                </button>
                {submitError && (
                  <p
                    role="alert"
                    className="text-xs text-destructive font-display text-center"
                  >
                    {submitError}
                  </p>
                )}
                <p className="text-[12px] text-muted-foreground text-center">
                  Quanto mais rápido acertar, mais pontos. Um palpite por hora!
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="result"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 220, damping: 18 }}
                className={
                  "sticker !px-4 !py-5 mt-3 text-center flex flex-col gap-4 " +
                  (displayResult?.correct ? "ring-gold" : "")
                }
              >
                {/* Impacto: veredito + pontos + streak */}
                <div className="flex flex-col items-center">
                  <Mascot
                    mood={displayResult?.correct ? "excited" : "sad"}
                    size={84}
                  />
                  <p className="font-display text-2xl mt-1">
                    {displayResult?.correct ? "Acertou!" : "Não foi dessa vez"}
                  </p>
                  <p
                    className={
                      "font-display text-[52px] leading-none mt-1 tabular-nums " +
                      (displayResult?.correct
                        ? "text-gold-grad"
                        : "text-muted-foreground")
                    }
                  >
                    +{displayResult?.score ?? 0}
                    <span className="text-2xl"> pts</span>
                  </p>
                  {result?.streak ? (
                    <span className="chip mt-2 !text-sun !border-sun/50 text-sm">
                      🔥 Streak: {result.streak} dia
                      {result.streak > 1 ? "s" : ""}
                    </span>
                  ) : null}
                </div>

                {/* Semelhança com a marca dos 80% (o corte para pontuar) */}
                {typeof displayResult?.similarity === "number" && (
                  <div className="text-left">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="eyebrow">Semelhança</span>
                      <span
                        className={
                          "font-display text-lg tabular-nums " +
                          (displayResult.correct ? "text-mint" : "text-pink")
                        }
                      >
                        {displayResult.similarity}%{" "}
                        {displayResult.correct ? "✓" : ""}
                      </span>
                    </div>
                    <div className="relative">
                      <div className="meter h-3.5">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${sim}%` }}
                          transition={{ duration: 0.9, ease: "easeOut" }}
                          className={
                            "h-full rounded-full " +
                            (displayResult.correct
                              ? "meter-fill-turq"
                              : "meter-fill-urgent")
                          }
                        />
                      </div>
                      <div
                        className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-[var(--c-ink)]/80"
                        style={{ left: "80%" }}
                        aria-hidden
                      />
                    </div>
                    <div className="relative h-4 mt-1">
                      <span
                        className="absolute -translate-x-1/2 text-[10px] font-bold text-muted-foreground whitespace-nowrap"
                        style={{ left: "80%" }}
                      >
                        80% pontua
                      </span>
                    </div>
                  </div>
                )}

                {/* Palpite × verdade */}
                <div className="grid gap-2.5 text-left lg:grid-cols-2">
                  {displayResult?.guess && (
                    <div className="rounded-2xl p-3 border border-pink/35 bg-pink/[0.08]">
                      <p className="eyebrow !text-pink mb-1">✍️ Seu palpite</p>
                      <p className="text-[15px] text-foreground leading-snug">
                        “{displayResult.guess}”
                      </p>
                    </div>
                  )}
                  {displayResult?.truth && (
                    <div className="rounded-2xl p-3 border border-mint/40 bg-mint/[0.1]">
                      <p className="eyebrow !text-mint mb-1">
                        ✓ Significado correto
                      </p>
                      <p className="text-[15px] leading-snug">
                        “{displayResult.truth}”
                      </p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex flex-col gap-2 min-w-0 lg:panel lg:p-5">
          <h2 className="font-display text-xl flex items-center gap-2">
            🏆 <span>Ranking de hoje</span>
          </h2>
          {board.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-3">
              Seja o primeiro a jogar hoje!
            </p>
          ) : (
            <ul className="space-y-2">
              {board.map((row, i) => {
                const mine = row.user_id === myId;
                const medal =
                  i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : null;
                return (
                  <li
                    key={row.user_id}
                    className={
                      "sticker !rounded-2xl !py-2 !px-3 flex items-center gap-2.5 text-sm " +
                      (i === 0 ? "ring-gold " : "") +
                      (mine ? "!border-pink/60" : "")
                    }
                  >
                    <span
                      className={
                        "font-display w-7 text-center text-lg tabular-nums " +
                        (i === 0 ? "text-sun" : "text-muted-foreground")
                      }
                    >
                      {medal ?? i + 1}
                    </span>
                    <span className="text-xl">
                      {row.profile?.avatar ?? "🦊"}
                    </span>
                    <span className="flex-1 truncate font-display">
                      {row.profile?.display_name ?? "Jogador"}
                      {mine ? (
                        <span className="text-muted-foreground"> (você)</span>
                      ) : null}
                    </span>
                    {row.is_correct ? (
                      <span className="text-mint text-xs font-bold">✓</span>
                    ) : (
                      <span className="text-muted-foreground text-xs">✗</span>
                    )}
                    <span
                      className={
                        "font-display text-lg tabular-nums " +
                        (i === 0
                          ? "text-sun"
                          : row.is_correct
                            ? "text-foreground"
                            : "text-muted-foreground")
                      }
                    >
                      {row.score}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
