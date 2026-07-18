import { memo, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  advanceAfterReveal, type Definition, type Player, type Room, type Vote, type Word,
} from "@/lib/room";
import { humanizeMeaning } from "@/lib/text-filter";
import { Mascot } from "@/components/Mascot";
import { PHASE_ANNOUNCER_TOTAL_MS } from "@/components/room/PhaseAnnouncer";
import { WordCard } from "@/components/room/shared";
import { playFooledMagnitude, playFooledOthersMagnitude, playPerfectRound, playSavage, playTailFreeze, playUITap } from "@/lib/sound";
import { getPlayerId } from "@/lib/player-id";
import { RevealFx } from "@/components/RevealFx";



function RevealImpl({ room, players, word, definitions, votes, isHost }: {
  room: Room; players: Player[]; word: Word; definitions: Definition[]; votes: Vote[]; isHost: boolean;
}) {
  const truth = useMemo(() => definitions.find((d) => (d.player_id === "__truth__")), [definitions]);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t1 = setTimeout(() => setStep(1), 1500);
    const t2 = setTimeout(() => setStep(2), 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const REVEAL_HOLD = 15;
  const TRANSITION_MS = PHASE_ANNOUNCER_TOTAL_MS;
  const [transitionDone, setTransitionDone] = useState(false);
  const latestPlayersRef = useRef(players);
  useEffect(() => { latestPlayersRef.current = players; }, [players]);
  useEffect(() => {
    setTransitionDone(false);
    const t = setTimeout(() => setTransitionDone(true), TRANSITION_MS);
    return () => clearTimeout(t);
  }, [room.id, room.current_round]);

  const [revealCountdown, setRevealCountdown] = useState(REVEAL_HOLD);
  useEffect(() => {
    if (step < 2 || !transitionDone) return;
    setRevealCountdown(REVEAL_HOLD);
    const iv = setInterval(() => {
      setRevealCountdown((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(iv);
  }, [step, transitionDone]);
  // Tail-freeze cinematográfico: 1.4s antes do scoreboard, em todos os clientes.
  const tailFreezePlayed = useRef(false);
  useEffect(() => {
    if (step < 2 || !transitionDone) return;
    if (tailFreezePlayed.current) return;
    if (revealCountdown !== 2) return;
    tailFreezePlayed.current = true;
    void playTailFreeze();
  }, [revealCountdown, step, transitionDone]);
  // Reset entre rodadas
  useEffect(() => { tailFreezePlayed.current = false; }, [room.id, room.current_round]);

  useEffect(() => {
    if (!isHost) return;
    if (step < 2 || !transitionDone) return;
    const t = setTimeout(() => advanceAfterReveal(room, latestPlayersRef.current), REVEAL_HOLD * 1000);
    return () => clearTimeout(t);
  }, [isHost, step, transitionDone, room.id, room.current_round]);

  const ordered = useMemo(
    () => [...definitions].sort((a, b) => (a.letter ?? "Z").localeCompare(b.letter ?? "Z")),
    [definitions],
  );

  // Stinger pessoal: quando step=2 (votos visíveis), tocar fooled/fooledOthers conforme resultado do jogador.
  const personalStingerPlayed = useRef(false);
  useEffect(() => {
    if (step < 2 || personalStingerPlayed.current) return;
    personalStingerPlayed.current = true;
    const myId = getPlayerId();
    if (!myId) return;
    const myVote = votes.find((v) => v.voter_id === myId);
    const truthDef = definitions.find((d) => (d.player_id === "__truth__"));
    const myDef = definitions.find((d) => d.player_id === myId);
    const iWasFooled = !!(myVote && truthDef && myVote.definition_id !== truthDef.id);
    const myDefVotes = myDef ? votes.filter((v) => v.definition_id === myDef.id).length : 0;
    // Total de jogadores enganados nesta rodada (escala o trombone)
    const totalFooled = truthDef
      ? votes.filter((v) => v.definition_id !== truthDef.id && v.voter_id !== "__truth__").length
      : 0;
    // Total de votantes (excluindo coordenador que não vota se aplicável) e detecção de marcos
    const totalVoters = votes.filter((v) => v.voter_id !== "__truth__").length;
    const isPerfectRound = myDef && myDefVotes >= totalVoters && totalVoters >= 3;
    const isSavage = myDefVotes >= 4;
    // Prioridade: perfect > savage > magnitude > fooled (positivo > negativo)
    setTimeout(() => {
      if (isPerfectRound) void playPerfectRound();
      else if (isSavage) void playSavage();
      else if (myDefVotes > 0) void playFooledOthersMagnitude(myDefVotes);
      else if (iWasFooled) void playFooledMagnitude(totalFooled);
    }, 600);
  }, [step, votes, definitions]);

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

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 min-h-0 flex flex-col gap-3 pt-2 overflow-x-hidden w-full max-w-full">
      <RevealFx trigger={step >= 1} strong />

      {step >= 2 && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="shrink-0 rounded-2xl px-4 py-2 bg-gradient-fun shadow-pop border-2 border-black/20 flex items-center justify-center gap-3 w-full max-w-full"
        >
          <span className="font-display text-sm uppercase tracking-wider text-white/90">📊 Placar em</span>
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
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain no-scrollbar pb-3 space-y-4 w-full max-w-full">
        <WordCard word={word} compact />

        {step < 1 && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Mascot mood="wow" size={130} />
            <p className="font-display text-2xl animate-pulse">Tãm tãm tãm…</p>
          </div>
        )}

        {step >= 1 && (
          <div className="relative overflow-hidden rounded-3xl">
            {/* Spotlight pulsante atrás da verdade */}
            <motion.div
              aria-hidden
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: [0, 0.7, 0.45], scale: [0.4, 1.3, 1.15] }}
              transition={{ duration: 1.4, ease: "easeOut" }}
              className="absolute inset-0 pointer-events-none"
              style={{
                background: "radial-gradient(closest-side, color-mix(in oklab, var(--mint) 50%, transparent), transparent 70%)",
                filter: "blur(20px)",
              }}
            />
            <motion.div
              initial={{ scale: 0.3, opacity: 0, y: -40, rotate: -3 }}
              animate={{ scale: [0.3, 1.15, 0.95, 1.02, 1], opacity: 1, y: 0, rotate: [-3, 2, -1, 0] }}
              transition={{ duration: 0.7, times: [0, 0.45, 0.7, 0.88, 1], ease: "easeOut" }}
              className="relative sticker bg-gradient-mint text-accent-foreground text-center py-6">
              <p className="text-sm uppercase tracking-wider font-display">A definição verdadeira é…</p>
              <p className="font-display text-2xl mt-2 leading-snug break-words">"{truth?.text}"</p>
            </motion.div>
          </div>
        )}

        {step >= 1 && <AboutWordCard word={word} />}


        {step >= 2 && (
          <div className="space-y-2">
          <p className="text-center text-xs uppercase tracking-wider font-display text-muted-foreground">
            🎬 replay da rodada — quem caiu em quem
          </p>
          {ordered.map((d) => {
            const author = playersById.get(d.player_id);
            const dVoters = votersByDefId.get(d.id) ?? [];
            return (
              <motion.div key={d.id} initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
                className={"sticker transition " + ((d.player_id === "__truth__") ? "bg-mint/25 border-2 border-mint ring-4 ring-mint/40 shadow-[0_0_30px_rgba(74,222,128,0.45)]" : "")}>
                <div className="flex items-start gap-2">
                  <span className="font-display text-2xl text-sun">{d.letter}</span>
                  <div className="flex-1">
                    <p className="text-base leading-snug">{d.text}</p>
                    <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
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
                    {dVoters.length > 0 && (
                      <div className="mt-2 flex items-center gap-1 flex-wrap">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-display mr-1">
                          {(d.player_id === "__truth__") ? "🎯 acertaram:" : "😂 caíram:"}
                        </span>
                        {dVoters.map((v, i) => (
                          <motion.div
                            key={v.id}
                            initial={{ scale: 0, y: -10 }}
                            animate={{ scale: 1, y: 0 }}
                            transition={{ delay: 0.1 + i * 0.15, type: "spring", stiffness: 260 }}
                            className={
                              "flex items-center gap-1 rounded-full pl-1 pr-2 py-0.5 text-xs font-display border " +
                              ((d.player_id === "__truth__")
                                ? "bg-mint/20 border-mint/40 text-mint"
                                : "bg-pink/15 border-pink/40 text-pink")
                            }
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
            <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
              <ShareReplayButton room={room} word={word} definitions={definitions} votes={votes} players={players} />
              {isHost && (
                <button
                  onClick={() => {
                    void playUITap("primary");
                    void playTailFreeze();
                    // Pequeno delay para o tail freeze "respirar" antes da transição
                    setTimeout(() => advanceAfterReveal(room, players), 1100);
                  }}
                  className="btn-pop bg-gradient-fun text-white px-5 py-2.5 text-sm font-display"
                  title="Pular contagem e ir direto ao placar"
                >
                  ⏭ Avançar agora
                </button>
              )}
            </div>
          </div>
        )}
      </div>

    </motion.div>
  );
}

// Momento de aprendizado (spec): curiosidade, origem, pronúncia e exemplo
// da palavra da rodada. Só renderiza os campos que existirem — palavras
// antigas/customizadas sem os dados v2 simplesmente não mostram o card.
function AboutWordCard({ word }: { word: Word }) {
  const hasContent = !!(word.curiosidade || word.origem || word.pronuncia || word.exemplo || word.classe);
  if (!hasContent) return null;
  return (
    <motion.div
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay: 0.6, duration: 0.4 }}
      className="sticker bg-card/70 border border-white/10 space-y-2"
    >
      <p className="text-center text-xs uppercase tracking-wider font-display text-sun">
        📖 sobre a palavra
      </p>
      <div className="flex items-baseline justify-center gap-2 flex-wrap">
        <span className="font-display text-lg capitalize">{word.word}</span>
        {word.pronuncia && <span className="text-sm text-muted-foreground font-body">[{word.pronuncia}]</span>}
        {word.classe && <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-display">{word.classe}</span>}
      </div>
      {word.curiosidade && (
        <p className="text-sm leading-snug text-foreground/90">💡 {word.curiosidade}</p>
      )}
      {word.origem && (
        <p className="text-xs text-muted-foreground">🌍 Origem: {word.origem}</p>
      )}
      {word.exemplo && (
        <p className="text-xs text-muted-foreground italic">✏️ "{word.exemplo}"</p>
      )}
    </motion.div>
  );
}

function ShareReplayButton({ room, word, definitions, votes, players }: {
  room: Room; word: Word; definitions: Definition[]; votes: Vote[]; players: Player[];
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | "shared" | "downloaded" | "error">(null);
  const onShare = async () => {
    if (busy) return;
    setBusy(true);
    const { shareReplayCard } = await import("@/lib/share-replay");
    const truth = definitions.find((d) => (d.player_id === "__truth__"));
    const truthHits = votes
      .filter((v) => v.definition_id === truth?.id)
      .map((v) => players.find((p) => p.id === v.voter_id))
      .filter((p): p is Player => !!p)
      .map((p) => ({ name: p.nickname, emoji: p.avatar }));
    const fooled = definitions
      .filter((d) => !(d.player_id === "__truth__") && d.player_id !== "__truth__")
      .map((d) => {
        const author = players.find((p) => p.id === d.player_id);
        const voters = votes
          .filter((v) => v.definition_id === d.id)
          .map((v) => players.find((p) => p.id === v.voter_id))
          .filter((p): p is Player => !!p)
          .map((p) => ({ name: p.nickname, emoji: p.avatar }));
        return author && voters.length > 0
          ? { author: author.nickname, emoji: author.avatar, voters, text: d.text }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.voters.length - a.voters.length);

    const result = await shareReplayCard({
      word: word.word,
      truth: truth?.text ?? humanizeMeaning(word.meaning),
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
      <button onClick={onShare} disabled={busy}
        className="btn-pop bg-gradient-sun text-primary-foreground px-5 py-2.5 text-sm font-display disabled:opacity-50">
        {busy ? "Gerando card…" : "📲 Compartilhar replay"}
      </button>
      {done === "shared" && <p className="text-xs text-mint font-display">Card enviado! 🎉</p>}
      {done === "downloaded" && <p className="text-xs text-mint font-display">Card baixado — manda no zap! 📥</p>}
      {done === "error" && <p className="text-xs text-destructive font-display">Não rolou — tenta de novo</p>}
    </div>
  );
}

export const Reveal = memo(RevealImpl);
export default Reveal;


