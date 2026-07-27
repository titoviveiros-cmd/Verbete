import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import { PHASE_ANNOUNCER_TOTAL_MS } from "@/components/room/PhaseAnnouncer";
import { WordCard } from "@/components/room/shared";
import {
  hapticBigWin,
  hapticFail,
  hapticSuccess,
  playFooledMagnitude,
  playFooledOthersMagnitude,
  playPerfectRound,
  playSavage,
  playTailFreeze,
  playUITap,
} from "@/lib/sound";
import { getPlayerId } from "@/lib/player-id";
import { scalePhaseSecs } from "@/lib/game-times";
import { RevealFx } from "@/components/RevealFx";
import { scrollbarClip } from "@/lib/utils";

// Fase 4 (aprovado 2026-07-20): clímax da revelação em etapas —
// blefes eliminados UM A UM (da cédula menos votada à mais votada, cada uma
// mostrando autor + quem caiu), pausa de suspense, a VERDADE surge por último
// em destaque e a "chuva de pontos" (+3 acertadores / +N blefadores) fecha.
// Mesmos cards/cores de antes; muda apenas a ordem dramática.
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
      const author = playersById.get(v.voter_id);
      if (!author) continue;
      const arr = map.get(v.definition_id);
      if (arr) arr.push(author);
      else map.set(v.definition_id, [author]);
    }
    return map;
  }, [votes, playersById]);

  // Blefes em ordem de drama: menos votados caem primeiro; o blefe mais
  // enganador é o último eliminado antes da verdade.
  const bluffs = useMemo(
    () =>
      definitions
        .filter((d) => d.player_id !== "__truth__")
        .sort((a, b) => {
          const va = votersByDefId.get(a.id)?.length ?? 0;
          const vb = votersByDefId.get(b.id)?.length ?? 0;
          if (va !== vb) return va - vb;
          return (a.letter ?? "Z").localeCompare(b.letter ?? "Z");
        }),
    [definitions, votersByDefId],
  );

  // ---- Máquina da coreografia -------------------------------------------
  const [elimCount, setElimCount] = useState(0);
  const [truthShown, setTruthShown] = useState(false);
  const [pointsShown, setPointsShown] = useState(false);

  const TRANSITION_MS = PHASE_ANNOUNCER_TOTAL_MS;
  const [transitionDone, setTransitionDone] = useState(false);
  useEffect(() => {
    setTransitionDone(false);
    setElimCount(0);
    setTruthShown(false);
    setPointsShown(false);
    const t = setTimeout(() => setTransitionDone(true), TRANSITION_MS);
    return () => clearTimeout(t);
  }, [room.id, room.current_round]);

  useEffect(() => {
    if (!transitionDone) return;
    const n = bluffs.length;
    // Orçamento: ~7s de eliminações independentemente do nº de blefes.
    const stepMs = Math.min(1500, Math.max(700, 7000 / Math.max(1, n)));
    const timers: ReturnType<typeof setTimeout>[] = [];
    let t = 900; // suspense inicial (mascote "Tãm tãm tãm…")
    for (let i = 1; i <= n; i++) {
      timers.push(
        setTimeout(() => {
          setElimCount(i);
          void playUITap("secondary");
        }, t),
      );
      t += stepMs;
    }
    t += 700; // pausa de suspense antes da verdade
    timers.push(setTimeout(() => setTruthShown(true), t));
    timers.push(setTimeout(() => setPointsShown(true), t + 900));
    return () => timers.forEach(clearTimeout);
  }, [transitionDone, room.current_round, bluffs.length]);

  // Coreografia (~7s) + contagem = menor que o backstop do cron, que também
  // escala com o nº de jogadores (public.phase_secs + folga em salas grandes).
  // `players` já vem sem expulsos (use-room filtra kicked_at).
  const REVEAL_HOLD = scalePhaseSecs(12, players.length);
  const latestPlayersRef = useRef(players);
  useEffect(() => {
    latestPlayersRef.current = players;
  }, [players]);

  const [revealCountdown, setRevealCountdown] = useState(REVEAL_HOLD);
  useEffect(() => {
    if (!truthShown) return;
    setRevealCountdown(REVEAL_HOLD);
    const iv = setInterval(() => {
      setRevealCountdown((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(iv);
  }, [truthShown]);

  // Tail-freeze cinematográfico: 1.4s antes do scoreboard, em todos os clientes.
  const tailFreezePlayed = useRef(false);
  useEffect(() => {
    if (!truthShown) return;
    if (tailFreezePlayed.current) return;
    if (revealCountdown !== 2) return;
    tailFreezePlayed.current = true;
    void playTailFreeze();
  }, [revealCountdown, truthShown]);
  useEffect(() => {
    tailFreezePlayed.current = false;
  }, [room.id, room.current_round]);

  useEffect(() => {
    if (!isHost || !truthShown) return;
    const t = setTimeout(
      () => advanceAfterReveal(room, latestPlayersRef.current),
      REVEAL_HOLD * 1000,
    );
    return () => clearTimeout(t);
  }, [isHost, truthShown, room.id, room.current_round]);

  // Stinger pessoal no momento da verdade (perfeito > savage > magnitude).
  const personalStingerPlayed = useRef(false);
  useEffect(() => {
    if (!truthShown || personalStingerPlayed.current) return;
    personalStingerPlayed.current = true;
    const myId = getPlayerId();
    if (!myId) return;
    const myVote = votes.find((v) => v.voter_id === myId);
    const truthDef = definitions.find((d) => d.player_id === "__truth__");
    const myDef = definitions.find((d) => d.player_id === myId);
    const iWasFooled = !!(
      myVote &&
      truthDef &&
      myVote.definition_id !== truthDef.id
    );
    const myDefVotes = myDef
      ? votes.filter((v) => v.definition_id === myDef.id).length
      : 0;
    const totalFooled = truthDef
      ? votes.filter(
          (v) => v.definition_id !== truthDef.id && v.voter_id !== "__truth__",
        ).length
      : 0;
    const totalVoters = votes.filter((v) => v.voter_id !== "__truth__").length;
    const isPerfectRound =
      myDef && myDefVotes >= totalVoters && totalVoters >= 3;
    const isSavage = myDefVotes >= 4;
    const iHitTruth = !!(
      myVote &&
      truthDef &&
      myVote.definition_id === truthDef.id
    );
    setTimeout(() => {
      // Fase 5: haptics contam a mesma história que os stingers
      if (isPerfectRound) {
        void playPerfectRound();
        hapticBigWin();
      } else if (isSavage) {
        void playSavage();
        hapticBigWin();
      } else if (myDefVotes > 0) {
        void playFooledOthersMagnitude(myDefVotes);
        hapticSuccess();
      } else if (iWasFooled) {
        void playFooledMagnitude(totalFooled);
        hapticFail();
      } else if (iHitTruth) {
        hapticSuccess();
      }
    }, 600);
  }, [truthShown, votes, definitions]);

  const truthVoters = truth ? (votersByDefId.get(truth.id) ?? []) : [];

  // Bônus 🧠 "chegou perto da verdade" (pedido 2026-07-21): o juiz de IA
  // pontua segundos após a virada — re-consulta get_room_reveal até o fim
  // da contagem para o badge +3 aparecer assim que for concedido.
  const [nearTruthIds, setNearTruthIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setNearTruthIds(new Set());
    let alive = true;
    let tries = 0;
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
      if (ids.length === 0 && tries < 8) setTimeout(fetchNear, 2000);
    };
    void fetchNear();
    return () => {
      alive = false;
    };
  }, [room.id, room.current_round]);
  // Chip do card da verdade = TOTAL da rodada de quem acertou (pedido
  // 2026-07-21, sala 7621): +3 do acerto, +3 se o próprio blefe foi
  // quase-verdade E +1 por voto recebido no próprio blefe (3+3+1 = +7).
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

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex-1 min-h-0 flex flex-col gap-3 pt-2 overflow-x-hidden w-full max-w-full"
    >
      <RevealFx trigger={truthShown} strong />

      {truthShown && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="shrink-0 rounded-2xl px-4 py-2 bg-gradient-fun shadow-pop border-2 border-black/20 flex items-center justify-center gap-3 w-full max-w-full"
        >
          <span className="font-display text-sm uppercase tracking-wider text-white/90">
            📊 Placar em
          </span>
          <motion.span
            key={revealCountdown}
            initial={{ scale: 1.4 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.25 }}
            className="font-display text-4xl text-white tabular-nums drop-shadow"
          >
            {revealCountdown}
          </motion.span>
          <span className="font-display text-sm text-white/90">s</span>
        </motion.div>
      )}
      <div
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain no-scrollbar pb-3 space-y-3 w-full max-w-full"
        style={scrollbarClip()}
      >
        <WordCard word={word} compact />

        {elimCount === 0 && !truthShown && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Mascot mood="wow" size={130} />
            <p className="font-display text-2xl animate-pulse">Tãm tãm tãm…</p>
          </div>
        )}

        {/* Pausa de suspense (topo) antes da verdade */}
        {elimCount >= bluffs.length && elimCount > 0 && !truthShown && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center font-display text-xl text-mint animate-pulse py-2"
          >
            E a verdade é… 🥁
          </motion.p>
        )}

        {/* Clímax: a VERDADE — no TOPO da pilha (pedido 2026-07-20: revelar
            de baixo para cima, com a resposta correta coroando o topo). */}
        {truthShown && (
          <div className="relative overflow-hidden rounded-3xl">
            <motion.div
              aria-hidden
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: [0, 0.7, 0.45], scale: [0.4, 1.3, 1.15] }}
              transition={{ duration: 1.4, ease: "easeOut" }}
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(closest-side, color-mix(in oklab, var(--mint) 50%, transparent), transparent 70%)",
                filter: "blur(20px)",
              }}
            />
            <motion.div
              initial={{ scale: 0.3, opacity: 0, y: 40, rotate: -3 }}
              animate={{
                scale: [0.3, 1.15, 0.95, 1.02, 1],
                opacity: 1,
                y: 0,
                rotate: [-3, 2, -1, 0],
              }}
              transition={{
                duration: 0.7,
                times: [0, 0.45, 0.7, 0.88, 1],
                ease: "easeOut",
              }}
              className="relative sticker bg-gradient-mint text-accent-foreground text-center py-6"
            >
              <p className="text-sm uppercase tracking-wider font-display">
                ✅ A definição verdadeira é…
              </p>
              <p className="font-display text-2xl mt-2 leading-snug break-words">
                "{truth?.text}"
              </p>
              {truthVoters.length > 0 && (
                <div className="mt-3 flex items-center justify-center gap-1.5 flex-wrap px-3">
                  <span className="text-[10px] uppercase tracking-wider font-display opacity-80 mr-1">
                    🎯 acertaram:
                  </span>
                  {truthVoters.map((v, i) => (
                    <motion.div
                      key={v.id}
                      initial={{ scale: 0, y: -10 }}
                      animate={{ scale: 1, y: 0 }}
                      transition={{
                        delay: 0.25 + i * 0.15,
                        type: "spring",
                        stiffness: 260,
                      }}
                      className="flex items-center gap-1 rounded-full pl-1 pr-2 py-0.5 text-xs font-display border bg-white/25 border-white/40"
                    >
                      <span className="text-sm">{v.avatar}</span>
                      <span>{v.nickname}</span>
                      {pointsShown && (
                        <motion.span
                          initial={{ scale: 0, y: 8 }}
                          animate={{ scale: 1, y: 0 }}
                          transition={{ type: "spring", stiffness: 300 }}
                          className="rounded-full bg-white/40 px-1.5 text-[11px] font-display"
                        >
                          {/* total da rodada: +3 acerto, +3 🧠, +1 por voto
                              no próprio blefe (pedido 2026-07-21) */}
                          +{3 + (roundExtraByPlayer.get(v.id) ?? 0)}
                        </motion.span>
                      )}
                    </motion.div>
                  ))}
                </div>
              )}
              {truthVoters.length === 0 && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className="mt-3 text-xs font-display opacity-90"
                >
                  😱 NINGUÉM acertou — coordenador leva +2!
                </motion.p>
              )}
            </motion.div>
          </div>
        )}

        {/* Eliminação dos blefes: a pilha cresce PARA CIMA — o mais recente
            entra no topo da lista, logo abaixo da verdade. */}
        {elimCount > 0 && (
          <div className="space-y-2">
            <p className="text-center text-xs uppercase tracking-wider font-display text-muted-foreground">
              {truthShown
                ? "🤥 os blefes da rodada"
                : "❌ eliminando os blefes…"}
            </p>
            {[...bluffs.slice(0, elimCount)].reverse().map((d) => {
              const author = playersById.get(d.player_id);
              const dVoters = votersByDefId.get(d.id) ?? [];
              return (
                <motion.div
                  key={d.id}
                  initial={{ x: -28, opacity: 0, rotate: -1.5 }}
                  animate={{ x: 0, opacity: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 240, damping: 20 }}
                  className="sticker"
                >
                  <div className="flex items-start gap-2">
                    <span className="font-display text-2xl text-sun">
                      {d.letter}
                    </span>
                    <div className="flex-1">
                      <p className="text-base leading-snug line-through decoration-pink/60 decoration-2">
                        {d.text}
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
                        {author && (
                          <span className="font-display flex items-center gap-1">
                            🤥{" "}
                            <span className="text-base">{author.avatar}</span>
                            {author.nickname}
                          </span>
                        )}
                        {(dVoters.length > 0 || nearTruthIds.has(d.id)) && (
                          <span className="ml-auto text-pink font-display flex items-center gap-1">
                            {dVoters.length > 0 && (
                              <>
                                +{dVoters.length} voto
                                {dVoters.length > 1 ? "s" : ""}
                              </>
                            )}
                            {pointsShown && author && dVoters.length > 0 && (
                              <motion.span
                                initial={{ scale: 0, y: 8 }}
                                animate={{ scale: 1, y: 0 }}
                                transition={{ type: "spring", stiffness: 300 }}
                                className="rounded-full bg-sun/20 border border-sun text-sun px-1.5 py-0.5 text-[11px]"
                              >
                                +{dVoters.length} pt
                                {dVoters.length > 1 ? "s" : ""}
                              </motion.span>
                            )}
                            {/* 🧠 quase a verdade: +3 do juiz de IA (pedido
                                2026-07-21 — aparecia só no placar) */}
                            {pointsShown && nearTruthIds.has(d.id) && (
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
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-display mr-1">
                            😂 caíram:
                          </span>
                          {dVoters.map((v, i) => (
                            <motion.div
                              key={v.id}
                              initial={{ scale: 0, y: -10 }}
                              animate={{ scale: 1, y: 0 }}
                              transition={{
                                delay: 0.1 + i * 0.12,
                                type: "spring",
                                stiffness: 260,
                              }}
                              className="flex items-center gap-1 rounded-full pl-1 pr-2 py-0.5 text-xs font-display border bg-pink/15 border-pink/40 text-pink"
                            >
                              <span className="text-sm">{v.avatar}</span>
                              <span>{v.nickname}</span>
                            </motion.div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}

        {truthShown && (
          <div className="pt-1 flex flex-wrap items-center justify-center gap-2">
            <ShareReplayButton
              room={room}
              word={word}
              definitions={definitions}
              votes={votes}
              players={players}
            />
            {isHost && (
              <button
                onClick={() => {
                  void playUITap("primary");
                  void playTailFreeze();
                  setTimeout(() => advanceAfterReveal(room, players), 1100);
                }}
                className="btn-pop bg-gradient-fun text-white px-5 py-2.5 text-sm font-display"
                title="Pular contagem e ir direto ao placar"
              >
                ⏭ Avançar agora
              </button>
            )}
          </div>
        )}
      </div>
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
      .filter(
        (d) => !(d.player_id === "__truth__") && d.player_id !== "__truth__",
      )
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
    setDone(result);
    setBusy(false);
    setTimeout(() => setDone(null), 3500);
  };
  return (
    <div className="pt-2 flex flex-col items-center gap-1">
      <button
        onClick={onShare}
        disabled={busy}
        className="btn-pop bg-gradient-sun text-primary-foreground px-5 py-2.5 text-sm font-display disabled:opacity-50"
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
