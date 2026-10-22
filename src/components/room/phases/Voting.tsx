import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  applyVotingTimeoutOrAdvance,
  castBotVotes,
  castVote,
  revealAndScore,
  type Definition,
  type Player,
  type Room,
  type Vote,
  type Word,
} from "@/lib/room";
import { playVoteCast, vibrate } from "@/lib/sound";
import { getStored } from "@/lib/player-id";
import { scalePhaseSecs } from "@/lib/game-times";
import { ReportButton } from "@/components/room/ReportButton";
import type { RoundExtension } from "@/hooks/use-room";
import { RING_GUTTER, scrollbarClip } from "@/lib/utils";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function VotingImpl({
  room,
  players,
  word,
  definitions,
  votes,
  me,
  isHost,
  isDeputy,
  roundExtensions,
}: {
  room: Room;
  players: Player[];
  word: Word;
  definitions: Definition[];
  votes: Vote[];
  me: Player;
  isHost: boolean;
  isDeputy: boolean;
  roundExtensions: RoundExtension[];
}) {
  const ordered = useMemo(
    () =>
      [...definitions].sort((a, b) =>
        (a.letter ?? "Z").localeCompare(b.letter ?? "Z"),
      ),
    [definitions],
  );
  const roundVotes = useMemo(
    () => votes.filter((v) => v.round === room.current_round),
    [votes, room.current_round],
  );
  const myVote = useMemo(
    () => roundVotes.find((v) => v.voter_id === me?.id),
    [roundVotes, me?.id],
  );
  // S1: cédulas chegam sem autor — a própria definição é identificada pelo
  // id devolvido no envio (persistido em `mydef:<sala>:<rodada>`).
  const myDefId = useMemo(
    () => getStored<string>(`mydef:${room.id}:${room.current_round}`, ""),
    [room.id, room.current_round],
  );
  const myDef = useMemo(
    () =>
      definitions.find(
        (d) =>
          d.id === myDefId || (d.player_id !== "" && d.player_id === me?.id),
      ),
    [definitions, myDefId, me?.id],
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = room.round_phase_ends_at
    ? Math.max(
        0,
        Math.floor((new Date(room.round_phase_ends_at).getTime() - now) / 1000),
      )
    : 0;

  // Coordenador TAMBÉM vota — todos os jogadores precisam votar para avançar.
  const voters = useMemo(() => players.filter((p) => !p.kicked_at), [players]);
  const voterIds = useMemo(() => new Set(voters.map((p) => p.id)), [voters]);
  // Sala 7850: votos OTIMISTAS (id `pending_*`) não contam no quórum de
  // avanço — contá-los disparava o advance em corrida com o próprio
  // cast_vote, e a rodada pontuava sem o voto real. (O servidor agora também
  // tem guard de quórum; aqui evitamos sequer tentar.)
  const validVotes = useMemo(
    () =>
      roundVotes.filter(
        (v) => voterIds.has(v.voter_id) && !String(v.id).startsWith("pending"),
      ),
    [roundVotes, voterIds],
  );
  const allVoted = voters.length > 0 && validVotes.length >= voters.length;
  const pending = useMemo(
    () => voters.filter((p) => !roundVotes.some((v) => v.voter_id === p.id)),
    [voters, roundVotes],
  );

  // Bots votam POR ÚLTIMO (playtest 2026-10-22): o servidor escolhe o voto
  // deles, e um voto de bot visível enquanto humanos ainda votam seria uma
  // pista da verdade. O host pede assim que o último humano vota (ou no fim
  // do prazo, no handler do tempo) — uma vez por rodada.
  const botsVotedRef = useRef<number | null>(null);
  const humansPending = pending.some((p) => !p.is_bot);
  const pendingHumans = useMemo(
    () => pending.filter((p) => !p.is_bot),
    [pending],
  );
  const voteBots = useCallback(async () => {
    if (botsVotedRef.current === room.current_round) return;
    const bots = players.filter((p) => p.is_bot && !p.kicked_at);
    // Só com o BALLOT real (cédulas com letra): no mount a lista ainda pode
    // ser o shape da fase de escrita (sem letras) ou estar vazia.
    const ballot = definitions.filter(
      (d) => d.letter && d.round === room.current_round,
    );
    if (!bots.length || !ballot.length) return;
    botsVotedRef.current = room.current_round;
    try {
      await castBotVotes(room.id, room.current_round, bots, ballot);
    } catch (e) {
      console.error("castBotVotes failed", e);
      botsVotedRef.current = null;
    }
  }, [players, definitions, room.id, room.current_round]);
  useEffect(() => {
    if (!isHost || humansPending) return;
    void voteBots();
  }, [isHost, humansPending, voteBots]);

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
          const revealed = await revealAndScore(
            room,
            players,
            definitions,
            snapshot,
            room.current_coordinator!,
          );
          if (revealed) {
            revealFiredRef.current = room.current_round;
            return;
          }
        } catch (e) {
          console.error("revealAndScore failed", e);
        }
        await wait(800);
      }
      revealInFlightRef.current = false;
    };
    if (delay === 0) {
      void fire();
      return () => {
        cancelled = true;
      };
    }
    const t = setTimeout(() => {
      void fire();
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [allVoted, isHost, isDeputy, room.current_round]);

  // Quando o tempo zera sem todos terem votado, host/deputy chama a RPC que
  // aplica prorrogação (até 2x, 15s) ou remove os ausentes. Se a fase não foi
  // estendida, dispara reveal. Outros clientes fazem fallback para reveal direto
  // (revealAndScore é idempotente) após delay maior.
  useEffect(() => {
    if (revealFiredRef.current === room.current_round) return;
    if (room.paused_at) return; // pausada: o prazo não vale até retomar
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
            const { action, extended, advanced } =
              await applyVotingTimeoutOrAdvance(room.id);
            if (extended) return; // sala recebeu +20s/+15s, timer reinicia
            if (advanced) {
              // prazo acabou com humano sem votar: os bots votam agora
              if (isHost) await voteBots();
              if (revealFiredRef.current === room.current_round) return;
              if (revealInFlightRef.current) return;
              revealInFlightRef.current = true;
              const revealed = await revealAndScore(
                room,
                players,
                definitions,
                snapshot,
                room.current_coordinator!,
              );
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
      const revealed = await revealAndScore(
        room,
        players,
        definitions,
        roundVotes,
        room.current_coordinator!,
      );
      if (revealed) revealFiredRef.current = room.current_round;
      else revealInFlightRef.current = false;
    }, 9000);
    return () => clearTimeout(t);
  }, [
    remaining,
    allVoted,
    isHost,
    isDeputy,
    room.id,
    room.current_round,
    room.round_phase_ends_at,
    room.paused_at,
    pending.length,
  ]);

  const [optimisticVoteId, setOptimisticVoteId] = useState<string | null>(null);
  useEffect(() => {
    if (myVote) setOptimisticVoteId(null);
  }, [myVote?.id]);
  useEffect(() => {
    setOptimisticVoteId(null);
  }, [room.current_round]);

  const effectiveVoteDefId = myVote?.definition_id ?? optimisticVoteId;
  const hasVoted = !!effectiveVoteDefId;

  // Retomada da aba (playtest 5G): logo após voltar do background, o estado
  // pode estar a ~1s de sincronizar — segura toques na cédula nessa janela e
  // usa a marca para explicar direito quando a rodada expirou na ausência.
  const resumedAtRef = useRef(0);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onResume = () => {
      if (document.visibilityState === "visible")
        resumedAtRef.current = Date.now();
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("pageshow", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("pageshow", onResume);
    };
  }, []);

  const handleVote = useCallback(
    async (defId: string) => {
      if (hasVoted || (myDef && myDef.id === defId)) return;
      // Acabou de voltar do background: espera a sincronização (~1.2s)
      // antes de aceitar o toque — evita votar numa fase já virada.
      if (Date.now() - resumedAtRef.current < 1200) return;
      void playVoteCast();
      vibrate(12); // Fase 5: confirmação tátil crisp do voto
      setOptimisticVoteId(defId);
      try {
        await castVote(room.id, room.current_round, me.id, defId);
      } catch (e) {
        console.error("castVote failed", e);
        setOptimisticVoteId(null);
        // Feedback explícito: com o lock server-side, voto na virada do
        // timer é rejeitado — sem este aviso o jogador achava que tinha
        // votado e estranhava o placar.
        const msg = String((e as Error)?.message ?? "");
        const { toast } = await import("sonner");
        if (msg.includes("wrong_phase")) {
          const awayRecently = Date.now() - resumedAtRef.current < 8000;
          toast.error(
            awayRecently
              ? "⏰ A votação terminou enquanto você estava fora do app — seu voto não contou nesta rodada."
              : "⏰ O tempo acabou antes do seu voto — ele não contou nesta rodada.",
          );
        } else {
          toast.error("Não foi possível registrar seu voto. Tente de novo.");
        }
      }
    },
    [hasVoted, myDef, room.id, room.current_round, me?.id],
  );

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
    Math.max(
      0,
      (p.voting_extensions ?? 0) -
        (baselineVotingExtRef.current.get(p.id) ?? p.voting_extensions ?? 0),
    );
  const activeExtension = useMemo(
    () => voters.reduce((max, p) => Math.max(max, deltaExt(p)), 0),
    [voters, room.current_round],
  );
  const timerMax = scalePhaseSecs(
    activeExtension >= 2 ? 15 : activeExtension === 1 ? 20 : 40,
    players.length,
  );
  const myExt = me ? deltaExt(me) : 0;
  const showExtBanner = !myVote && myExt > 0;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex-1 flex flex-col gap-1.5 pt-1 min-h-0 relative overflow-x-hidden ring-room lg:justify-center lg:gap-3"
    >
      {/* Halo de urgência nos últimos 3s — vinheta vermelha pulsante */}
      {critical && (
        <motion.div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-30"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0.0, 0.55, 0.0] }}
          transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
          style={{
            boxShadow:
              "inset 0 0 80px 20px color-mix(in oklab, var(--destructive) 55%, transparent)",
          }}
        />
      )}
      <div className="word-hero shrink-0 flex items-center gap-3 px-4 py-2 lg:py-3 w-full max-w-full">
        <div
          className="flex-1 min-w-0 no-copy"
          onCopy={(e) => e.preventDefault()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <p className="eyebrow !text-white/85 !text-[10px] leading-none">
            Qual é o significado de
          </p>
          <h2 className="font-display text-stroke text-2xl lg:text-3xl text-white leading-tight truncate capitalize">
            {word.word}
          </h2>
        </div>
        <motion.div
          animate={critical ? { scale: [1, 1.18, 1] } : { scale: 1 }}
          transition={
            critical
              ? { duration: 0.6, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
          className={
            "font-display tabular-nums text-4xl leading-none shrink-0 " +
            (urgent
              ? "text-[#ffe14d] drop-shadow-[0_0_12px_rgba(255,80,80,0.8)]"
              : "text-white")
          }
        >
          {remaining}
          <span className="text-sm opacity-70">s</span>
        </motion.div>
      </div>
      <div className="meter shrink-0 h-1.5">
        <motion.div
          className={
            "h-full rounded-full " +
            (urgent ? "meter-fill-urgent" : "meter-fill-gold")
          }
          animate={{ width: `${(remaining / timerMax) * 100}%` }}
          transition={{ duration: 0.5, ease: "linear" }}
        />
      </div>
      {showExtBanner && (
        <div
          className={
            "shrink-0 rounded-xl px-3 py-2 text-center font-display text-xs border " +
            (myExt >= 2
              ? "bg-destructive/15 border-destructive text-destructive"
              : "bg-pink/15 border-pink text-pink")
          }
        >
          {myExt === 1 && (
            <>
              ⏰ Tempo esgotado! Você perdeu <b>1 ponto</b>. Mais 20s pra votar
              — se faltar de novo, perde outro ponto. Na 3ª falha, é eliminado.
            </>
          )}
          {myExt >= 2 && (
            <>
              ⚠️ Última chance! Vote agora ou será <b>eliminado da partida</b>{" "}
              (já perdeu {myExt} pts no total).
            </>
          )}
        </div>
      )}

      <div
        className="flex flex-col gap-2.5 flex-1 lg:flex-initial min-h-0 overflow-y-auto overflow-x-hidden no-scrollbar no-copy pt-2 pb-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:content-start"
        // Respiro do anel rosa: a cédula escolhida (ring-neon + escala)
        // passava da caixa da lista e saía aparada (playtest 2026-10-20).
        style={scrollbarClip(undefined, RING_GUTTER)}
        onCopy={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {ordered.map((d, i) => {
          // S1: as cédulas chegam sem autor — a própria é reconhecida pelo
          // id guardado no envio (fallback pro player_id em salas antigas).
          const isMine =
            d.id === myDefId || (d.player_id !== "" && d.player_id === me?.id);
          const isPicked = effectiveVoteDefId === d.id;
          return (
            // A cédula (botão de voto) e o 🚩 de denúncia são IRMÃOS: botão
            // dentro de botão confunde leitor de tela e toque (axe:
            // nested-interactive — já existia antes desta rodada).
            <div
              key={d.id}
              className="relative flex flex-1 min-h-[60px] lg:min-h-[92px]"
            >
              <motion.button
                whileTap={{ scale: 0.97 }}
                whileHover={hasVoted || isMine ? undefined : { y: -2 }}
                // Cédulas entram em cascata (peças sendo distribuídas); depois
                // só a escala reage à escolha. A opacidade (votou/sua) vive
                // aqui porque o motion escreve style inline.
                initial={{ opacity: 0, y: 14 }}
                animate={{
                  opacity: hasVoted && !isPicked ? 0.45 : isMine ? 0.6 : 1,
                  y: 0,
                  scale: isPicked ? [1, 1.04, 1.02] : 1,
                }}
                transition={{
                  scale: { duration: 0.4 },
                  opacity: { delay: i * 0.05, duration: 0.25 },
                  y: {
                    delay: i * 0.05,
                    type: "spring",
                    stiffness: 280,
                    damping: 22,
                  },
                }}
                disabled={hasVoted || isMine}
                onClick={() => handleVote(d.id)}
                className={
                  "sticker relative w-full flex-1 !rounded-2xl !pl-3 !py-3 !pr-3 text-left flex gap-3 items-center transition " +
                  (isPicked ? "ring-neon" : "")
                }
              >
                <span className={"token" + (isPicked ? " token-gold" : "")}>
                  {d.letter}
                </span>
                <p className="font-body text-base lg:text-[17px] font-semibold flex-1 leading-snug">
                  {d.text}
                </p>
                {isMine && (
                  <span className="chip !text-mint !border-mint/40 !text-[10px] shrink-0">
                    SUA
                  </span>
                )}
                {isPicked && (
                  <motion.span
                    initial={{ scale: 0, rotate: -30 }}
                    animate={{ scale: 1, rotate: 0 }}
                    className="ml-auto bg-[var(--v-neon)] text-white rounded-full w-7 h-7 flex items-center justify-center font-display text-sm shadow-md ring-2 ring-white shrink-0"
                    aria-label="Voto registrado"
                  >
                    ✓
                  </motion.span>
                )}
              </motion.button>
              {!isMine && (
                // Canto superior direito, fora da área de escolha (a cédula
                // inteira fica livre para o texto e a letra).
                <div
                  className={
                    "absolute -top-2 -right-1.5 z-10 " +
                    (hasVoted && !isPicked ? "opacity-45" : "")
                  }
                >
                  <ReportButton
                    definition={d}
                    room={room}
                    players={players}
                    meId={me.id}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Status da votação numa linha fina (playtest 2026-10-20): a altura
          fica com as cédulas. */}
      <div className="shrink-0 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground font-display px-2 pt-0.5">
        <span className="eyebrow tabular-nums">
          {roundVotes.length}/{voters.length} votaram
        </span>
        {pendingHumans.length > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>faltam:</span>
            {pendingHumans.slice(0, 6).map((p, i) => (
              <span key={p.id} className="whitespace-nowrap text-foreground/85">
                {p.avatar} {p.nickname}
                {i < Math.min(pendingHumans.length, 6) - 1 ? "," : ""}
              </span>
            ))}
            {pendingHumans.length > 6 && (
              <span className="opacity-70">+{pendingHumans.length - 6}</span>
            )}
          </>
        ) : pending.length > 0 ? (
          // só bots faltando: eles votam por último, logo depois dos humanos
          <span>· 🤖 bots votando…</span>
        ) : (
          <span className="text-mint">· ✨ todos votaram!</span>
        )}
      </div>
    </motion.div>
  );
}

export const Voting = memo(VotingImpl);
export default Voting;
