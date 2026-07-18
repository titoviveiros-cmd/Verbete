import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  applyVotingTimeoutOrAdvance, botsVote, castVote, revealAndScore,
  type Definition, type Player, type Room, type Vote, type Word,
} from "@/lib/room";
import { playVoteCast } from "@/lib/sound";
import { ReportButton } from "@/components/room/ReportButton";
import type { RoundExtension } from "@/hooks/use-room";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function VotingImpl({ room, players, word, definitions, votes, me, isHost, isDeputy, roundExtensions }: {
  room: Room; players: Player[]; word: Word; definitions: Definition[]; votes: Vote[]; me: Player; isHost: boolean; isDeputy: boolean; roundExtensions: RoundExtension[];
}) {
  const ordered = useMemo(
    () => [...definitions].sort((a, b) => (a.letter ?? "Z").localeCompare(b.letter ?? "Z")),
    [definitions],
  );
  const roundVotes = useMemo(
    () => votes.filter((v) => v.round === room.current_round),
    [votes, room.current_round],
  );
  const myVote = useMemo(() => roundVotes.find((v) => v.voter_id === me?.id), [roundVotes, me?.id]);
  const myDef = useMemo(() => definitions.find((d) => d.player_id === me?.id), [definitions, me?.id]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const remaining = room.round_phase_ends_at ? Math.max(0, Math.floor((new Date(room.round_phase_ends_at).getTime() - now) / 1000)) : 0;

  // Coordenador TAMBÉM vota — todos os jogadores precisam votar para avançar.
  const voters = useMemo(() => players.filter((p) => !p.kicked_at), [players]);
  const voterIds = useMemo(() => new Set(voters.map((p) => p.id)), [voters]);
  const validVotes = useMemo(
    () => roundVotes.filter((v) => voterIds.has(v.voter_id)),
    [roundVotes, voterIds],
  );
  const allVoted = voters.length > 0 && validVotes.length >= voters.length;
  const pending = useMemo(
    () => voters.filter((p) => !roundVotes.some((v) => v.voter_id === p.id)),
    [voters, roundVotes],
  );

  const botsVotedRef = useRef(false);
  useEffect(() => {
    if (!isHost) return;
    if (botsVotedRef.current) return;
    const bots = players.filter((p) => p.is_bot);
    if (bots.length) {
      botsVotedRef.current = true;
      botsVote(room.id, room.current_round, bots, definitions);
    }
  }, [isHost, players, room.id, room.current_round, definitions]);

  const revealFiredRef = useRef<number | null>(null);
  const revealInFlightRef = useRef(false);
  const votingTimeoutHandledRef = useRef<string | null>(null);

  // Quando todos votaram, dispara reveal direto.
  useEffect(() => {
    if (revealFiredRef.current === room.current_round) return;
    if (!allVoted) return;
    if (roundVotes.length === 0) return;
    const delay = isHost ? 0 : isDeputy ? 1500 : 3500;
    const snapshot = roundVotes;
    let cancelled = false;
    const fire = async () => {
      if (cancelled) return;
      if (revealFiredRef.current === room.current_round) return;
      if (revealInFlightRef.current) return;
      revealInFlightRef.current = true;
      // Retry: o guard server-side pode ver o último voto como ainda não
      // propagado e devolver false. Tentamos algumas vezes antes de desistir.
      for (let tries = 0; tries < 5 && !cancelled; tries++) {
        try {
          const revealed = await revealAndScore(room, players, definitions, snapshot, room.current_coordinator!);
          if (revealed) { revealFiredRef.current = room.current_round; return; }
        } catch (e) {
          console.error("revealAndScore failed", e);
        }
        await wait(800);
      }
      revealInFlightRef.current = false;
    };
    if (delay === 0) { void fire(); return () => { cancelled = true; }; }
    const t = setTimeout(() => { void fire(); }, delay);
    return () => { cancelled = true; clearTimeout(t); };
  }, [allVoted, isHost, isDeputy, room.current_round]);

  // Quando o tempo zera sem todos terem votado, host/deputy chama a RPC que
  // aplica prorrogação (até 2x, 15s) ou remove os ausentes. Se a fase não foi
  // estendida, dispara reveal. Outros clientes fazem fallback para reveal direto
  // (revealAndScore é idempotente) após delay maior.
  useEffect(() => {
    if (revealFiredRef.current === room.current_round) return;
    if (remaining > 0 || !room.round_phase_ends_at) return;

    if (isHost || isDeputy) {
      const key = `${room.id}:${room.current_round}:${room.round_phase_ends_at}`;
      if (votingTimeoutHandledRef.current === key) return;
      const phaseEndsAt = room.round_phase_ends_at;
      const delay = isHost ? 600 : 6000;
      const snapshot = roundVotes;
      const t = setTimeout(async () => {
        if (votingTimeoutHandledRef.current === key) return;
        votingTimeoutHandledRef.current = key;
        try {
          const endsAt = new Date(phaseEndsAt).getTime();
          const msUntilBackendGrace = endsAt + 2300 - Date.now();
          if (msUntilBackendGrace > 0) await wait(msUntilBackendGrace);
          for (let tries = 0; tries < 4; tries++) {
            const { action, extended, advanced } = await applyVotingTimeoutOrAdvance(room.id);
            if (extended) return; // sala recebeu +20s/+15s, timer reinicia
            if (advanced) {
              if (revealFiredRef.current === room.current_round) return;
              if (revealInFlightRef.current) return;
              revealInFlightRef.current = true;
              const revealed = await revealAndScore(room, players, definitions, snapshot, room.current_coordinator!);
              if (revealed) revealFiredRef.current = room.current_round;
              else revealInFlightRef.current = false;
              return;
            }
            if (action !== "noop_grace") return;
            await wait(900);
          }
          votingTimeoutHandledRef.current = null;
        } catch (e) {
          console.error("voting timeout handler failed", e);
          votingTimeoutHandledRef.current = null;
        }
      }, delay);
      return () => clearTimeout(t);
    }

    // Cliente comum: fallback caso host/deputy estejam fora — só fecha após
    // janela ampla, dando tempo de a prorrogação propagar via realtime.
    const t = setTimeout(async () => {
      if (revealFiredRef.current === room.current_round) return;
      if (pending.length > 0) {
        try {
          const { advanced } = await applyVotingTimeoutOrAdvance(room.id);
          if (!advanced) return;
        } catch (e) {
          console.error("voting fallback timeout handler failed", e);
          return;
        }
      }
      if (revealInFlightRef.current) return;
      revealInFlightRef.current = true;
      const revealed = await revealAndScore(room, players, definitions, roundVotes, room.current_coordinator!);
      if (revealed) revealFiredRef.current = room.current_round;
      else revealInFlightRef.current = false;
    }, 9000);
    return () => clearTimeout(t);
  }, [remaining, allVoted, isHost, isDeputy, room.id, room.current_round, room.round_phase_ends_at, pending.length]);

  const [optimisticVoteId, setOptimisticVoteId] = useState<string | null>(null);
  useEffect(() => {
    if (myVote) setOptimisticVoteId(null);
  }, [myVote?.id]);
  useEffect(() => { setOptimisticVoteId(null); }, [room.current_round]);

  const effectiveVoteDefId = myVote?.definition_id ?? optimisticVoteId;
  const hasVoted = !!effectiveVoteDefId;

  const handleVote = useCallback(async (defId: string) => {
    if (hasVoted || (myDef && myDef.id === defId)) return;
    void playVoteCast();
    setOptimisticVoteId(defId);
    try {
      await castVote(room.id, room.current_round, me.id, defId);
    } catch (e) {
      console.error("castVote failed", e);
      setOptimisticVoteId(null);
    }
  }, [hasVoted, myDef, room.id, room.current_round, me?.id]);

  const urgent = remaining <= 10;
  const critical = remaining > 0 && remaining <= 3;
  // voting_extensions é cumulativo na partida — para saber se a prorrogação é
  // DESTA rodada, tiramos um snapshot ao entrar na fase e contamos só o delta.
  const baselineVotingExtRef = useRef<Map<string, number>>(new Map());
  const baselineRoundRef = useRef<number | null>(null);
  if (baselineRoundRef.current !== room.current_round) {
    baselineRoundRef.current = room.current_round;
    const map = new Map<string, number>();
    for (const p of voters) map.set(p.id, p.voting_extensions ?? 0);
    baselineVotingExtRef.current = map;
  }
  const deltaExt = (p: Player) =>
    Math.max(0, (p.voting_extensions ?? 0) - (baselineVotingExtRef.current.get(p.id) ?? (p.voting_extensions ?? 0)));
  const activeExtension = useMemo(
    () => voters.reduce((max, p) => Math.max(max, deltaExt(p)), 0),
    [voters, room.current_round],
  );
  const timerMax = activeExtension >= 2 ? 15 : activeExtension === 1 ? 20 : 40;
  const myExt = me ? deltaExt(me) : 0;
  const showExtBanner = !myVote && myExt > 0;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col gap-1.5 pt-1 min-h-0 relative overflow-x-hidden w-full max-w-full">
      {/* Halo de urgência nos últimos 3s — vinheta vermelha pulsante */}
      {critical && (
        <motion.div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-30"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0.0, 0.55, 0.0] }}
          transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
          style={{
            boxShadow: "inset 0 0 80px 20px color-mix(in oklab, var(--destructive) 55%, transparent)",
          }}
        />
      )}
      <div className="shrink-0 flex items-center gap-2 rounded-2xl bg-gradient-fun px-3 py-1.5 shadow-pop w-full max-w-full">
        <div className="flex-1 min-w-0 no-copy" onCopy={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}>
          <p className="text-[9px] uppercase tracking-widest font-display opacity-80 leading-none">A palavra é</p>
          <h2 className="font-display text-stroke text-xl text-white leading-tight truncate capitalize">{word.word}</h2>
        </div>
        <motion.div
          animate={critical ? { scale: [1, 1.18, 1] } : { scale: 1 }}
          transition={critical ? { duration: 0.6, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
          className={"font-display tabular-nums text-3xl leading-none shrink-0 " + (urgent ? "text-destructive drop-shadow-[0_0_10px_rgba(255,80,80,0.5)]" : "text-white")}
        >
          {remaining}<span className="text-sm opacity-70">s</span>
        </motion.div>
      </div>
      <div className="shrink-0 h-1 w-full bg-card rounded-full overflow-hidden border border-white/10">
        <motion.div className={"h-full " + (urgent ? "bg-destructive" : "bg-sun")} animate={{ width: `${(remaining / timerMax) * 100}%` }} transition={{ duration: 0.5, ease: "linear" }} />
      </div>
      {showExtBanner && (
        <div className={"shrink-0 rounded-xl px-3 py-2 text-center font-display text-xs border " + (myExt >= 2 ? "bg-destructive/15 border-destructive text-destructive" : "bg-pink/15 border-pink text-pink")}>
          {myExt === 1 && <>⏰ Tempo esgotado! Você perdeu <b>25 pontos</b>. Mais 20s pra votar — se faltar de novo, perde mais 25. Na 3ª falha, é eliminado.</>}
          {myExt >= 2 && <>⚠️ Última chance! Vote agora ou será <b>eliminado da partida</b> (já perdeu {myExt * 25} pts no total).</>}
        </div>
      )}


      <div
        className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto overflow-x-hidden no-scrollbar no-copy pb-2 w-full max-w-full"
        onCopy={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {ordered.map((d) => {
          const isMine = d.player_id === me?.id;
          const isPicked = effectiveVoteDefId === d.id;
          return (
            <motion.button
              key={d.id}
              whileTap={{ scale: 0.97 }}
              animate={isPicked ? { scale: [1, 1.04, 1.02] } : { scale: 1 }}
              transition={{ duration: 0.4 }}
              disabled={hasVoted || isMine}
              onClick={() => handleVote(d.id)}
              className={
                "relative w-full flex-1 min-h-[60px] rounded-2xl bg-card border-2 border-white/10 px-3 py-3 text-left flex gap-2 items-center transition shadow-pop " +
                (isPicked ? "ring-4 ring-pink bg-pink/10" : "") +
                (hasVoted && !isPicked ? " opacity-40" : "") +
                (isMine ? " opacity-50" : "")
              }
            >
              <span className="font-display text-2xl text-sun w-6 shrink-0 leading-none">{d.letter}</span>
              <p className="font-body text-base flex-1 leading-snug">{d.text}</p>
              {isMine && <span className="text-[10px] text-mint font-display shrink-0">SUA</span>}
              {!isMine && (
                <span onClick={(e) => e.stopPropagation()} className="shrink-0">
                  <ReportButton definition={d} room={room} players={players} meId={me.id} />
                </span>
              )}
              {isPicked && (
                <motion.span
                  initial={{ scale: 0, rotate: -30 }}
                  animate={{ scale: 1, rotate: 0 }}
                  className="ml-auto bg-pink text-white rounded-full w-6 h-6 flex items-center justify-center font-display text-sm shadow-md ring-2 ring-white shrink-0"
                  aria-label="Voto registrado"
                >
                  ✓
                </motion.span>
              )}
            </motion.button>
          );
        })}
      </div>

      <div className="shrink-0 flex flex-col items-center gap-1 text-[11px] text-muted-foreground font-display px-2">
        <span className="tabular-nums">{roundVotes.length}/{voters.length}</span>
        {pending.length > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-1.5 max-w-full">
            {pending.slice(0, 6).map((p) => (
              <span key={p.id}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card/60 border border-white/10">
                <span className="text-sm leading-none">{p.avatar}</span>
                <span className="text-[11px] text-foreground/80 max-w-[80px] truncate">{p.nickname}</span>
              </span>
            ))}
            {pending.length > 6 && <span className="opacity-70">+{pending.length - 6}</span>}
          </div>
        ) : (
          <span className="text-mint">✨ todos votaram!</span>
        )}
      </div>
    </motion.div>
  );
}

export const Voting = memo(VotingImpl);
export default Voting;


