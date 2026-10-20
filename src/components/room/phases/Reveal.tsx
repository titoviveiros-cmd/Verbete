import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  advanceAfterReveal,
  type Definition,
  type Player,
  type Room,
  type Vote,
  type Word,
} from "@/lib/room";
import { humanizeMeaning } from "@/lib/text-filter";
import { Mascot } from "@/components/Mascot";
import { WordCard } from "@/components/room/shared";
import {
  hapticBigWin,
  hapticFail,
  hapticSuccess,
  playCorrectReveal,
  playCrowdReactionFooled,
  playCrowdReactionNoOne,
  playFooled,
  playFooledOthersMagnitude,
  playImpact,
  playPerfectRound,
  playPointGained,
  playSavage,
  playTailFreeze,
  playUITap,
} from "@/lib/sound";
import { getPlayerId } from "@/lib/player-id";
import { scalePhaseSecs } from "@/lib/game-times";
import { RevealFx } from "@/components/RevealFx";
import { scrollbarClip } from "@/lib/utils";
import {
  HOLD_BASE_SECS,
  bestBluffId,
  bluffQuip,
  correctHeadline,
  orderBluffs,
  planReveal,
  type RevealStep,
} from "@/lib/reveal-plan";

// Revelação "verdade primeiro" (2026-10-20): VERDADE → QUEM ACERTOU → BLEFES
// (do que passou batido ao que mais enganou) → BLEFE DA RODADA → leitura →
// placar. Um relógio único: o que aparece é função do tempo decorrido desde a
// entrada e do plano determinístico (reveal-plan.ts) — host e convidados veem
// a mesma sequência. Todo som/vibração da revelação sai DAQUI, um por passo.
// Só apresentação: os números são os mesmos que o servidor já calculou.
function RevealImpl({
  room,
  players,
  word,
  definitions,
  votes,
  isHost,
}: {
  room: Room;
  players: Player[];
  word: Word;
  definitions: Definition[];
  votes: Vote[];
  isHost: boolean;
}) {
  const myId = useMemo(() => getPlayerId(), []);
  const truth = useMemo(
    () => definitions.find((d) => d.player_id === "__truth__"),
    [definitions],
  );
  const playersById = useMemo(() => {
    const map = new Map<string, Player>();
    for (const p of players) map.set(p.id, p);
    return map;
  }, [players]);
  const votersByDefId = useMemo(() => {
    const map = new Map<string, Player[]>();
    for (const v of votes) {
      const voter = playersById.get(v.voter_id);
      if (!voter) continue;
      const arr = map.get(v.definition_id);
      if (arr) arr.push(voter);
      else map.set(v.definition_id, [voter]);
    }
    return map;
  }, [votes, playersById]);
  const votesOf = useCallback(
    (id: string) => votersByDefId.get(id)?.length ?? 0,
    [votersByDefId],
  );
  // Votos desta rodada (em definições desta rodada) e quem votou.
  const roundVotes = useMemo(() => {
    const ids = new Set(definitions.map((d) => d.id));
    return votes.filter((v) => ids.has(v.definition_id));
  }, [definitions, votes]);
  const roundVoterIds = useMemo(
    () => new Set(roundVotes.map((v) => v.voter_id)),
    [roundVotes],
  );

  const bluffs = useMemo(
    () =>
      orderBluffs(
        definitions.filter((d) => d.player_id !== "__truth__"),
        votesOf,
      ),
    [definitions, votesOf],
  );
  const bestId = useMemo(() => bestBluffId(bluffs, votesOf), [bluffs, votesOf]);
  const plan = useMemo(
    () =>
      planReveal(
        bluffs.map((b) => votesOf(b.id)),
        bestId !== null,
      ),
    [bluffs, votesOf, bestId],
  );
  const planKey = plan.steps
    .map((s) => `${s.kind}${s.index ?? ""}@${s.at}`)
    .join("|");
  const roundKey = `${room.id}:${room.current_round}`;

  const truthVoters = truth ? (votersByDefId.get(truth.id) ?? []) : [];
  const myVote = roundVotes.find((v) => v.voter_id === myId);
  const iHitTruth = !!(truth && myVote && myVote.definition_id === truth.id);

  // ---- Relógio da coreografia --------------------------------------------
  const startRef = useRef(0);
  const advancingRef = useRef(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [advancing, setAdvancing] = useState(false);

  useEffect(() => {
    startRef.current = Date.now();
    advancingRef.current = false;
    setAdvancing(false);
    setElapsed(0);
  }, [roundKey]);

  // Agenda os próximos passos a partir do tempo já decorrido — se os dados da
  // rodada chegarem atrasados, o plano muda sem voltar no tempo.
  const planRef = useRef(plan);
  planRef.current = plan;
  useEffect(() => {
    if (advancingRef.current) return;
    const { steps, holdAt } = planRef.current;
    const now = Date.now() - startRef.current;
    setElapsed((e) => Math.max(e, Math.min(now, holdAt)));
    const timers = steps
      .filter((s) => s.at > now)
      .map((s) =>
        setTimeout(() => {
          if (!advancingRef.current) setElapsed((e) => Math.max(e, s.at));
        }, s.at - now),
      );
    return () => timers.forEach(clearTimeout);
  }, [roundKey, planKey]);

  const reached = (s: RevealStep | undefined) => !!s && elapsed >= s.at;
  const stepOf = (kind: RevealStep["kind"]) =>
    plan.steps.find((s) => s.kind === kind);
  const truthVisible = reached(stepOf("truth"));
  const correctVisible = reached(stepOf("correct"));
  const bridgeVisible = reached(stepOf("bridge"));
  const visibleBluffs = plan.steps.filter(
    (s) => s.kind === "bluff" && elapsed >= s.at,
  ).length;
  const bestVisible = reached(stepOf("best"));
  const holdReached = elapsed >= plan.holdAt;

  // Celular: o blefe recém-revelado entra no topo da lista, que nas telas
  // pequenas fica perto da borda de baixo — rola só o necessário para ele
  // aparecer inteiro (instantâneo com movimento reduzido).
  const bluffListRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (visibleBluffs === 0) return;
    const el = bluffListRef.current?.firstElementChild as HTMLElement | null;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView?.({
      block: "nearest",
      behavior: reduce ? "auto" : "smooth",
    });
  }, [visibleBluffs]);

  // Passo mais recente alcançado (o único que soa — nada de cacofonia se a
  // aba voltar do segundo plano com vários passos vencidos de uma vez).
  const currentStep = useMemo(() => {
    let cur: RevealStep | undefined;
    for (const s of plan.steps) if (elapsed >= s.at) cur = s;
    return cur;
  }, [plan, elapsed]);
  const stepId = currentStep
    ? `${currentStep.kind}${currentStep.index ?? ""}`
    : "";

  // ---- Som e vibração: um por passo ---------------------------------------
  // Dispara uma vez por passo (stepId); os dados vêm do render atual via ref.
  const live = useRef({
    currentStep,
    bluffs,
    bestId,
    votesOf,
    myVote,
    myId,
    roundVoterIds,
    truthVoters,
    iHitTruth,
  });
  live.current = {
    currentStep,
    bluffs,
    bestId,
    votesOf,
    myVote,
    myId,
    roundVoterIds,
    truthVoters,
    iHitTruth,
  };
  const playedRef = useRef<string>("");
  useEffect(() => {
    playedRef.current = "";
  }, [roundKey]);
  useEffect(() => {
    const {
      currentStep,
      bluffs,
      bestId,
      votesOf,
      myVote,
      myId,
      roundVoterIds,
      truthVoters,
      iHitTruth,
    } = live.current;
    if (!currentStep || advancingRef.current) return;
    const id = `${roundKey}:${stepId}`;
    if (playedRef.current === id) return;
    playedRef.current = id;
    const maxPossibleFor = (authorId: string) =>
      roundVoterIds.size - (roundVoterIds.has(authorId) ? 1 : 0);
    switch (currentStep.kind) {
      case "truth":
        void playImpact();
        return;
      case "correct":
        if (truthVoters.length === 0 && roundVoterIds.size > 0) {
          void playCrowdReactionNoOne();
        } else if (iHitTruth) {
          void playPointGained();
          hapticSuccess();
        } else if (truthVoters.length > 0) {
          void playCorrectReveal();
        }
        return;
      case "bluff": {
        const b = bluffs[currentStep.index ?? -1];
        if (!b) return;
        const n = votesOf(b.id);
        const fell = !!myVote && myVote.definition_id === b.id;
        if (b.player_id === myId && n > 0) {
          const max = maxPossibleFor(myId);
          if (max >= 3 && n >= max) {
            void playPerfectRound();
            hapticBigWin();
          } else if (n >= 4) {
            void playSavage();
            hapticBigWin();
          } else {
            void playFooledOthersMagnitude(n);
            hapticSuccess();
          }
        } else if (fell) {
          void playFooled();
          hapticFail();
        } else if (n > 0) {
          void playUITap("secondary");
        }
        return;
      }
      case "best": {
        const b = bluffs.find((x) => x.id === bestId);
        if (!b) return;
        if (b.player_id === myId) hapticBigWin();
        else void playCrowdReactionFooled(votesOf(b.id));
        return;
      }
      default:
        return;
    }
  }, [stepId, roundKey]);

  // ---- Leitura final, contagem e avanço ------------------------------------
  // Coreografia + leitura < backstop do servidor (phase_secs(20) escalado).
  // `players` já vem sem expulsos (use-room filtra kicked_at).
  const REVEAL_HOLD = scalePhaseSecs(HOLD_BASE_SECS, players.length);
  const latestPlayersRef = useRef(players);
  useEffect(() => {
    latestPlayersRef.current = players;
  }, [players]);

  const finish = useCallback(
    (manual: boolean) => {
      if (advancingRef.current) return;
      advancingRef.current = true;
      setAdvancing(true);
      const go = () => {
        advanceTimer.current = null;
        void advanceAfterReveal(room, latestPlayersRef.current).catch(() => {});
      };
      if (manual) {
        void playUITap("primary");
        void playTailFreeze();
        advanceTimer.current = setTimeout(go, 1100);
      } else go();
    },
    [room],
  );
  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    },
    [],
  );

  const [countdown, setCountdown] = useState<number | null>(null);
  const holdSecsRef = useRef(REVEAL_HOLD);
  holdSecsRef.current = REVEAL_HOLD;
  useEffect(() => {
    setCountdown(null);
  }, [roundKey]);
  useEffect(() => {
    if (!holdReached) return;
    setCountdown(holdSecsRef.current);
    const iv = setInterval(() => {
      setCountdown((s) => (s !== null && s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(iv);
  }, [holdReached, roundKey]);
  // Tail-freeze cinematográfico ~2 s antes do placar, em todos os clientes.
  const tailFreezePlayed = useRef("");
  useEffect(() => {
    if (countdown !== 2 || advancingRef.current) return;
    if (tailFreezePlayed.current === roundKey) return;
    tailFreezePlayed.current = roundKey;
    void playTailFreeze();
  }, [countdown, roundKey]);
  useEffect(() => {
    if (isHost && countdown === 0) finish(false);
  }, [isHost, countdown, finish]);

  // Bônus 🧠 "chegou perto da verdade": o juiz de IA pontua segundos após a
  // virada — re-consulta get_room_reveal para o badge +3 entrar ao vivo.
  const [nearTruthIds, setNearTruthIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setNearTruthIds(new Set());
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fetchNear = async () => {
      tries++;
      const { supabase } = await import("@/integrations/supabase/client");
      const { data } = await supabase.rpc("get_room_reveal", {
        p_room_id: room.id,
      });
      if (!alive) return;
      const ids: string[] =
        (data as { near_truth_ids?: string[] } | null)?.near_truth_ids ?? [];
      if (ids.length > 0) setNearTruthIds(new Set(ids));
      // A lista é da SALA inteira (bug da sala 7879): consulta até o fim.
      if (tries < 18) timer = setTimeout(fetchNear, 2000);
    };
    void fetchNear();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [room.id, room.current_round]);
  // Chip de quem acertou = TOTAL da rodada (pedido 2026-07-21): +3 do acerto,
  // +3 se o próprio blefe foi quase-verdade e +1 por voto no próprio blefe.
  const roundExtraByPlayer = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of definitions) {
      if (d.player_id === "__truth__") continue;
      let extra = m.get(d.player_id) ?? 0;
      extra += votersByDefId.get(d.id)?.length ?? 0;
      if (nearTruthIds.has(d.id)) extra += 3;
      m.set(d.player_id, extra);
    }
    return m;
  }, [definitions, votersByDefId, nearTruthIds]);

  // ---- Leitor de tela: anuncia só o passo atual ---------------------------
  const announcement = (() => {
    if (!currentStep) return "";
    switch (currentStep.kind) {
      case "truth":
        return `A definição verdadeira: ${truth?.text ?? humanizeMeaning(word.meaning ?? "")}`;
      case "correct":
        return `${correctHeadline(truthVoters.length, roundVoterIds.size, iHitTruth)} ${truthVoters.map((p) => p.nickname).join(", ")}`;
      case "bluff": {
        const b = bluffs[currentStep.index ?? -1];
        if (!b) return "";
        const author = playersById.get(b.player_id)?.nickname ?? "alguém";
        const fooled = votersByDefId.get(b.id) ?? [];
        return `Blefe de ${author}: ${b.text}. ${fooled.length} voto${fooled.length === 1 ? "" : "s"}${fooled.length ? `: ${fooled.map((p) => p.nickname).join(", ")}` : ""}`;
      }
      case "best": {
        const b = bluffs.find((x) => x.id === bestId);
        const author = b ? playersById.get(b.player_id)?.nickname : "";
        return b ? `Blefe da rodada: ${author}, enganou ${votesOf(b.id)}` : "";
      }
      case "hold":
        return `Placar em ${REVEAL_HOLD} segundos`;
      default:
        return "";
    }
  })();

  const headline = correctHeadline(
    truthVoters.length,
    roundVoterIds.size,
    iHitTruth,
  );
  // Mesma condição de antes para a linha do coordenador (+2 quando ninguém acerta).
  const nobodyHit = truthVoters.length === 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex-1 min-h-0 flex flex-col gap-3 pt-2 overflow-x-hidden w-full max-w-full"
    >
      <RevealFx trigger={truthVisible} strong />
      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>

      {holdReached && countdown !== null && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="shrink-0 self-center !rounded-full pl-4 pr-3 py-1.5 panel flex items-center justify-center gap-2.5 max-w-full"
        >
          <span className="eyebrow !text-foreground/85">📊 Placar em</span>
          <motion.span
            key={countdown}
            aria-hidden
            initial={{ scale: 1.4 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.25 }}
            className="font-display text-3xl text-sun tabular-nums leading-none"
          >
            {countdown}
          </motion.span>
          <span className="font-display text-sm text-muted-foreground">s</span>
        </motion.div>
      )}
      <div
        // Região rolável alcançável pelo teclado (os botões ficam fora dela).
        tabIndex={0}
        role="region"
        aria-label="Revelação da rodada"
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain no-scrollbar pb-3 space-y-3 w-full max-w-full"
        style={scrollbarClip()}
      >
        <WordCard word={word} compact />

        {/* Preparação curta (~0,5 s) antes da verdade. */}
        {!truthVisible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-1 py-6"
          >
            <p className="font-display text-2xl text-mint">✨ Revelação</p>
          </motion.div>
        )}

        {truthVisible && (
          <section
            aria-label="Resposta correta"
            className="relative overflow-hidden rounded-3xl"
          >
            <motion.div
              aria-hidden
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: [0, 0.7, 0.45], scale: [0.4, 1.3, 1.15] }}
              transition={{ duration: 1.1, ease: "easeOut" }}
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(closest-side, color-mix(in oklab, var(--mint) 50%, transparent), transparent 70%)",
                filter: "blur(20px)",
              }}
            />
            <motion.div
              initial={{ scale: 0.5, opacity: 0, y: 24 }}
              animate={{ scale: [0.5, 1.08, 1], opacity: 1, y: 0 }}
              transition={{
                duration: 0.45,
                times: [0, 0.6, 1],
                ease: "easeOut",
              }}
              className="relative truth-card text-center px-4 pt-4 pb-5"
            >
              <span className="truth-seal">✓ Verdade</span>
              <h2 className="eyebrow !text-[var(--c-on-turq)]/80">
                A definição verdadeira é…
              </h2>
              <p className="font-display text-[24px] sm:text-[26px] lg:text-[30px] mt-2 leading-snug break-words">
                “{truth?.text ?? humanizeMeaning(word.meaning ?? "")}”
              </p>

              {correctVisible && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-3 flex flex-col items-center gap-1.5 px-2"
                >
                  <p className="font-display text-base">{headline}</p>
                  {nobodyHit ? (
                    <div className="flex items-center gap-2">
                      <Mascot mood="sad" size={44} />
                      <p className="text-xs font-display opacity-90">
                        o coordenador leva +2
                      </p>
                    </div>
                  ) : (
                    <ul
                      className="flex items-center justify-center gap-1.5 flex-wrap"
                      aria-label="Quem acertou"
                    >
                      {truthVoters.map((v, i) => {
                        const me = v.id === myId;
                        return (
                          <motion.li
                            key={v.id}
                            initial={{ scale: 0, y: -8 }}
                            animate={{ scale: 1, y: 0 }}
                            // "Você acertou": mola mais saltada (spring só aceita 2 quadros)
                            transition={{
                              delay: 0.08 * i,
                              type: "spring",
                              stiffness: me ? 420 : 280,
                              damping: me ? 9 : 18,
                            }}
                            className={`flex items-center gap-1 rounded-full pl-1 pr-2 py-0.5 text-xs font-display border ${me ? "bg-white/60 border-white ring-2 ring-sun" : "bg-white/35 border-white/60"}`}
                          >
                            <span className="text-sm">{v.avatar}</span>
                            <span>{me ? "você" : v.nickname}</span>
                            <span className="rounded-full btn-gold !shadow-none px-1.5 text-[11px] font-display border border-white/80">
                              +{3 + (roundExtraByPlayer.get(v.id) ?? 0)}
                            </span>
                          </motion.li>
                        );
                      })}
                    </ul>
                  )}
                </motion.div>
              )}
            </motion.div>
          </section>
        )}

        {bridgeVisible && (
          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="eyebrow text-center"
          >
            Agora: quem enganou quem? 🤥
          </motion.p>
        )}

        {visibleBluffs > 0 && (
          <ol
            ref={bluffListRef}
            aria-label="Blefes da rodada"
            className="flex flex-col gap-2.5 lg:grid lg:grid-cols-2 lg:gap-3"
          >
            {[...bluffs.slice(0, visibleBluffs)].reverse().map((d) => {
              const author = playersById.get(d.player_id);
              const dVoters = votersByDefId.get(d.id) ?? [];
              const mine = d.player_id === myId;
              const fell = !!myVote && myVote.definition_id === d.id;
              const isBest = bestVisible && d.id === bestId;
              const maxPossible =
                roundVoterIds.size - (roundVoterIds.has(d.player_id) ? 1 : 0);
              return (
                <motion.li
                  key={d.id}
                  initial={{ y: -16, opacity: 0, scale: 0.97 }}
                  animate={{ y: 0, opacity: 1, scale: 1 }}
                  transition={{ type: "spring", stiffness: 260, damping: 22 }}
                  className={`sticker !pt-4 overflow-hidden relative ${mine ? "ring-2 ring-sun/70" : ""} ${isBest ? "shadow-[0_0_24px_var(--v-neon-glow)]" : ""}`}
                >
                  <span className="bluff-stamp" aria-hidden>
                    blefe
                  </span>
                  {isBest && (
                    <motion.div
                      initial={{ scale: 0.6, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="flex items-center gap-2 mb-2"
                    >
                      <span className="rounded-full btn-gold !shadow-none px-2.5 py-0.5 text-xs font-display">
                        🏆 Blefe da rodada
                      </span>
                      <Mascot mood="excited" size={36} />
                    </motion.div>
                  )}
                  <div className="flex items-start gap-3">
                    <span className="token !w-8 !h-8 !text-base opacity-80">
                      {d.letter}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap pr-14">
                        {author && (
                          <span className="font-display text-sm flex items-center gap-1">
                            ✍️{" "}
                            <span className="text-base">{author.avatar}</span>
                            {author.nickname}
                          </span>
                        )}
                        {mine && (
                          <span className="eyebrow !text-sun">seu blefe</span>
                        )}
                      </div>
                      <p className="text-base leading-snug text-foreground/90 mt-1 break-words">
                        “{d.text}”
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
                        <span className="font-display text-muted-foreground">
                          {bluffQuip(
                            dVoters.length,
                            maxPossible,
                            room.current_round,
                            d.letter,
                          )}
                        </span>
                        {(dVoters.length > 0 || nearTruthIds.has(d.id)) && (
                          <span className="ml-auto text-pink font-display flex items-center gap-1">
                            {dVoters.length > 0 && (
                              <span className="rounded-full bg-sun/20 border border-sun text-sun px-1.5 py-0.5 text-[11px]">
                                +{dVoters.length} pt
                                {dVoters.length > 1 ? "s" : ""}
                              </span>
                            )}
                            {/* 🧠 quase a verdade: +3 do juiz de IA */}
                            {nearTruthIds.has(d.id) && (
                              <motion.span
                                initial={{ scale: 0, y: 8 }}
                                animate={{ scale: 1, y: 0 }}
                                transition={{ type: "spring", stiffness: 300 }}
                                className="rounded-full bg-sun/20 border border-sun text-sun px-1.5 py-0.5 text-[11px]"
                              >
                                🧠 +3 pts
                              </motion.span>
                            )}
                          </span>
                        )}
                      </div>
                      {dVoters.length > 0 && (
                        <div className="mt-2 flex items-center gap-1 flex-wrap">
                          <span className="eyebrow mr-1">😂 caíram:</span>
                          <ul className="contents" aria-label="Quem caiu">
                            {dVoters.map((v, i) => {
                              const me = v.id === myId;
                              return (
                                <motion.li
                                  key={v.id}
                                  initial={{ scale: 0, y: -8 }}
                                  animate={{ scale: 1, y: 0 }}
                                  transition={{
                                    delay: 0.06 * i,
                                    type: "spring",
                                    stiffness: 280,
                                  }}
                                  className={`flex items-center gap-1 rounded-full pl-1 pr-2 py-0.5 text-xs font-display border ${me ? "bg-pink/30 border-pink ring-1 ring-pink" : "bg-pink/15 border-pink/40"} text-pink`}
                                >
                                  <span className="text-sm">{v.avatar}</span>
                                  <span>{me ? "você" : v.nickname}</span>
                                </motion.li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                      {fell && !mine && (
                        <p className="sr-only">Você caiu neste blefe.</p>
                      )}
                    </div>
                  </div>
                </motion.li>
              );
            })}
          </ol>
        )}
      </div>
      {/* Ações sempre à vista, fora da rolagem. */}
      {(truthVisible || holdReached) && (
        // max-lg:px-12: longe dos botões flutuantes (▾ reações, 💬 chat)
        <div className="shrink-0 flex flex-wrap items-center justify-center gap-2 max-lg:px-12">
          {holdReached && (
            <ShareReplayButton
              room={room}
              word={word}
              definitions={definitions}
              votes={votes}
              players={players}
            />
          )}
          {isHost && (
            <button
              onClick={() => finish(true)}
              disabled={advancing}
              className="btn-pop btn-gold px-5 py-2.5 text-base font-display disabled:opacity-60"
              title="Pular a revelação e ir direto ao placar"
            >
              {advancing ? "Indo pro placar…" : "⏭ Avançar agora"}
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}

function ShareReplayButton({
  room,
  word,
  definitions,
  votes,
  players,
}: {
  room: Room;
  word: Word;
  definitions: Definition[];
  votes: Vote[];
  players: Player[];
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | "shared" | "downloaded" | "error">(
    null,
  );
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const onShare = async () => {
    if (busy) return;
    setBusy(true);
    const { shareReplayCard } = await import("@/lib/share-replay");
    const truth = definitions.find((d) => d.player_id === "__truth__");
    const truthHits = votes
      .filter((v) => v.definition_id === truth?.id)
      .map((v) => players.find((p) => p.id === v.voter_id))
      .filter((p): p is Player => !!p)
      .map((p) => ({ name: p.nickname, emoji: p.avatar }));
    const fooled = definitions
      .filter((d) => d.player_id !== "__truth__")
      .map((d) => {
        const author = players.find((p) => p.id === d.player_id);
        const voters = votes
          .filter((v) => v.definition_id === d.id)
          .map((v) => players.find((p) => p.id === v.voter_id))
          .filter((p): p is Player => !!p)
          .map((p) => ({ name: p.nickname, emoji: p.avatar }));
        return author && voters.length > 0
          ? {
              author: author.nickname,
              emoji: author.avatar,
              voters,
              text: d.text,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.voters.length - a.voters.length);

    const result = await shareReplayCard({
      word: word.word,
      truth: truth?.text ?? humanizeMeaning(word.meaning ?? ""),
      fooled,
      truthHits,
      roomCode: room.code,
    });
    if (!alive.current) return;
    setDone(result);
    setBusy(false);
    setTimeout(() => {
      if (alive.current) setDone(null);
    }, 3500);
  };
  return (
    <div className="pt-2 flex flex-col items-center gap-1">
      <button
        onClick={onShare}
        disabled={busy}
        className="btn-pop btn-violet px-5 py-2.5 text-base font-display"
      >
        {busy ? "Gerando card…" : "📲 Compartilhar replay"}
      </button>
      {done === "shared" && (
        <p className="text-xs text-mint font-display">Card enviado! 🎉</p>
      )}
      {done === "downloaded" && (
        <p className="text-xs text-mint font-display">
          Card baixado — manda no zap! 📥
        </p>
      )}
      {done === "error" && (
        <p className="text-xs text-destructive font-display">
          Não rolou — tenta de novo
        </p>
      )}
    </div>
  );
}

export const Reveal = memo(RevealImpl);
export default Reveal;
