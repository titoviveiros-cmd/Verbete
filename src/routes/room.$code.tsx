import { APP_URL } from "@/lib/app-url";
import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRoom } from "@/hooks/use-room";
import { getPlayerId, getStored, setPlayerId } from "@/lib/player-id";
import {
  fetchThreeWords,
  chooseWord,
  joinRoom,
  leaveRoom,
  restartGame,
  migrateHost,
  type RoomMode,
} from "@/lib/room";
import { randomAvatar, randomColor } from "@/lib/avatars";
import { Mascot } from "@/components/Mascot";
import { ReactionsLayer } from "@/components/ReactionsLayer";
import { RoomChat } from "@/components/room/RoomChat";
import {
  PhaseAnnouncer,
  PHASE_ANNOUNCER_TOTAL_MS,
} from "@/components/room/PhaseAnnouncer";
import {
  playAlert,
  primeAudio,
  playCorrectReveal,
  playGameWin,
  playPointMagnitude,
  playVoteReceived,
  playRevealStinger,
  playWhooshUp,
  playRevealBuildUp,
  playCrowdReactionFooled,
  playCrowdReactionNoOne,
  playStreak,
} from "@/lib/sound";
import { setMusicMood, stopMusic } from "@/lib/music";

import { TopBar } from "@/components/room/TopBar";
import { JoinFlow } from "@/components/room/JoinFlow";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ---------- Code-split por fase ----------
// Cada fase do jogo vira um chunk separado. O usuário só baixa o JS da fase
// que está vendo, reduzindo o bundle inicial de ~2k linhas para ~350.
const Lobby = lazy(() => import("@/components/room/phases/Lobby"));
const ChooseWord = lazy(() => import("@/components/room/phases/ChooseWord"));
const WriteDefinition = lazy(
  () => import("@/components/room/phases/WriteDefinition"),
);
const Shuffling = lazy(() => import("@/components/room/phases/Shuffling"));
const Voting = lazy(() => import("@/components/room/phases/Voting"));
const Reveal = lazy(() => import("@/components/room/phases/Reveal"));
const Scoreboard = lazy(() => import("@/components/room/phases/Scoreboard"));
const Finished = lazy(() => import("@/components/room/phases/Finished"));

const PhaseFallback = () => (
  <div className="flex-1 flex items-center justify-center">
    <Mascot mood="thinking" size={90} />
  </div>
);

/** Quantos votos um único jogador (que não seja "__truth__") recebeu na rodada.
 *  Usado para detectar perfect round / savage e suprimir crowd genérico. */
function countMaxFooledByOnePlayer(
  roundVotes: Array<{ definition_id: string }>,
  truthDefId: string,
  definitions: Array<{ id: string; player_id: string | null }>,
): number {
  const counts = new Map<string, number>();
  for (const v of roundVotes) {
    if (v.definition_id === truthDefId) continue;
    const def = definitions.find((d) => d.id === v.definition_id);
    if (!def || !def.player_id || def.player_id === "__truth__") continue;
    counts.set(def.player_id, (counts.get(def.player_id) ?? 0) + 1);
  }
  let max = 0;
  counts.forEach((c) => {
    if (c > max) max = c;
  });
  return max;
}

export const Route = createFileRoute("/room/$code")({
  head: ({ params }) => ({
    meta: [
      { title: `Sala ${params.code} — Verbete` },
      {
        name: "description",
        content: `Entre na sala ${params.code} do Verbete e jogue agora com seus amigos.`,
      },
      { property: "og:title", content: `Sala ${params.code} — Verbete` },
      {
        property: "og:description",
        content: "Junte-se à partida em tempo real.",
      },
      { property: "og:url", content: `${APP_URL}/room/${params.code}` },
      { name: "robots", content: "noindex,follow" },
    ],
  }),
  component: RoomPage,
});

function RoomPage() {
  const { code } = useParams({ from: "/room/$code" });
  const nav = useNavigate();
  if (typeof window !== "undefined") {
    const hostedId = getStored<string>("hosted:" + code, "");
    const currentId = getPlayerId();
    if (hostedId && hostedId !== currentId) {
      setPlayerId(hostedId);
    }
  }
  const playerId = typeof window !== "undefined" ? getPlayerId() : "";
  const {
    room,
    players,
    definitions,
    votes,
    word,
    roundExtensions,
    loading,
    error,
    degraded,
    reload,
  } = useRoom(code, playerId);
  const [confirmReset, setConfirmReset] = useState(false);

  const isHost = !!room && room.host_id === playerId;
  const me = players.find((p) => p.id === playerId && !p.kicked_at);
  const currentCoordinator = room
    ? players.find((p) => p.id === room.current_coordinator)
    : undefined;

  const isDeputy = useMemo(() => {
    if (!room || !playerId) return false;
    const humans = players
      .filter((p) => !p.is_bot && p.id !== room.host_id)
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.joined_at ?? 0).getTime();
        const tb = new Date(b.joined_at ?? 0).getTime();
        if (ta !== tb) return ta - tb;
        return a.id.localeCompare(b.id);
      });
    return humans[0]?.id === playerId;
  }, [players, room?.host_id, playerId]);

  useEffect(() => {
    void primeAudio();
  }, []);

  // Pré-carrega a próxima fase em idle — o usuário entra na fase com o chunk
  // já em cache, evitando o flash do fallback.
  useEffect(() => {
    if (!room) return;
    const ric =
      (window as any).requestIdleCallback ??
      ((cb: () => void) => setTimeout(cb, 200));
    ric(() => {
      switch (room.status) {
        case "lobby":
          import("@/components/room/phases/ChooseWord");
          break;
        case "choosing":
          import("@/components/room/phases/WriteDefinition");
          break;
        case "writing":
          import("@/components/room/phases/Shuffling");
          import("@/components/room/phases/Voting");
          break;
        case "shuffling":
          import("@/components/room/phases/Voting");
          break;
        case "voting":
          import("@/components/room/phases/Reveal");
          break;
        case "reveal":
          import("@/components/room/phases/Scoreboard");
          break;
        case "scoreboard":
          import("@/components/room/phases/Finished");
          break;
      }
    });
  }, [room?.status]);

  const lastAttentionKeyRef = useRef<string | null>(null);
  const hasMyDefinition = definitions.some((d) => d.player_id === playerId);
  const hasMyVote = votes.some((v) => v.voter_id === playerId);
  useEffect(() => {
    if (!room || !me) return;
    const needsAttention =
      (room.status === "writing" &&
        room.current_coordinator !== playerId &&
        !hasMyDefinition) ||
      (room.status === "voting" && !hasMyVote);
    const key = `${room.id}:${room.current_round}:${room.status}`;
    if (!needsAttention || lastAttentionKeyRef.current === key) return;
    lastAttentionKeyRef.current = key;
    const t = setTimeout(() => {
      void playAlert();
    }, PHASE_ANNOUNCER_TOTAL_MS + 80);
    return () => clearTimeout(t);
  }, [
    room?.id,
    room?.status,
    room?.current_round,
    room?.current_coordinator,
    me?.id,
    playerId,
    hasMyDefinition,
    hasMyVote,
  ]);

  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!room) return;
    const prev = prevStatusRef.current;
    prevStatusRef.current = room.status;
    if (prev === undefined || prev === room.status) return;
    void primeAudio();
    // Whoosh em toda transição (exceto entrar no reveal/finished, que têm stingers próprios)
    if (room.status !== "reveal" && room.status !== "finished")
      void playWhooshUp();
    // Trilha dinâmica por fase
    switch (room.status) {
      case "lobby":
      case "choosing":
        setMusicMood("lobby");
        break;
      case "writing":
      case "voting":
      case "shuffling":
        setMusicMood("tension");
        break;
      case "reveal":
        setMusicMood("reveal");
        // Build-up cinematográfico: drumroll + riser + crash → stinger.
        // playCorrectReveal só toca se ALGUÉM acertou (senão soaria cínico).
        void playRevealBuildUp();
        setTimeout(() => {
          void playRevealStinger();
        }, 1200);
        // Reação coletiva e acorde resolvido — só se não houver stinger personalizado pesado
        setTimeout(() => {
          try {
            const truthDef = definitions.find(
              (d) => d.player_id === "__truth__",
            );
            if (!truthDef) return;
            const roundVotes = votes.filter(
              (v) => v.round === room.current_round,
            );
            const correctCount = roundVotes.filter(
              (v) => v.definition_id === truthDef.id,
            ).length;
            const fooledCount = roundVotes.length - correctCount;
            // Toca o acorde C maj9 só quando alguém acertou (representa "resolução")
            if (correctCount > 0) void playCorrectReveal();

            // Skip reações genéricas quando o Reveal.tsx vai disparar perfect/savage
            // (4+ enganados por um único jogador = stinger personalizado já inclui crowd).
            const maxFooledByOne = countMaxFooledByOnePlayer(
              roundVotes,
              truthDef.id,
              definitions,
            );
            const willPlayPerfectOrSavage =
              maxFooledByOne >= 4 ||
              (maxFooledByOne >= 3 && maxFooledByOne >= roundVotes.length);
            if (willPlayPerfectOrSavage) return;

            if (roundVotes.length > 0 && correctCount === 0) {
              void playCrowdReactionNoOne();
            } else if (fooledCount >= 1) {
              void playCrowdReactionFooled(fooledCount);
            }
          } catch {}
        }, 2400);
        break;
      case "finished":
        setMusicMood("victory");
        void playGameWin();
        break;
      case "scoreboard":
        setMusicMood("lobby");
        break;
    }
  }, [room?.status, room?.id]);

  // Para a música quando o componente desmonta (saída da sala)
  useEffect(
    () => () => {
      stopMusic();
    },
    [],
  );

  const prevMyScoreRef = useRef<number | null>(null);
  const streakCountRef = useRef(0);
  const lastStreakRoundRef = useRef<number | null>(null);
  useEffect(() => {
    if (!me || !room) return;
    const prev = prevMyScoreRef.current;
    prevMyScoreRef.current = me.score;
    if (prev === null) return;
    const delta = me.score - prev;
    if (delta > 0) {
      void playPointMagnitude(delta);
      // Streak: pontuar em rodadas consecutivas
      if (
        lastStreakRoundRef.current === room.current_round - 1 ||
        lastStreakRoundRef.current === null
      ) {
        streakCountRef.current += 1;
      } else if (lastStreakRoundRef.current !== room.current_round) {
        streakCountRef.current = 1;
      }
      lastStreakRoundRef.current = room.current_round;
      // 3+ rodadas seguidas pontuando = streak stinger (depois do som de pontos)
      if (streakCountRef.current >= 3) {
        setTimeout(() => {
          void playStreak(streakCountRef.current);
        }, 900);
      }
    } else if (
      me.score === prev &&
      lastStreakRoundRef.current !== null &&
      lastStreakRoundRef.current !== room.current_round
    ) {
      // não pontuou nesta rodada → quebra a streak
      streakCountRef.current = 0;
    }
  }, [me?.score, room?.current_round]);

  const prevVotesForMeRef = useRef<number | null>(null);
  const prevVotingKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!room || room.status !== "voting" || !me) return;
    const phaseKey = `${room.id}:${room.current_round}`;
    if (prevVotingKeyRef.current !== phaseKey) {
      prevVotingKeyRef.current = phaseKey;
      prevVotesForMeRef.current = null;
    }
    const myDef = definitions.find((d) => d.player_id === playerId);
    if (!myDef) return;
    const votesForMe = votes.filter((v) => v.definition_id === myDef.id).length;
    const prev = prevVotesForMeRef.current;
    prevVotesForMeRef.current = votesForMe;
    if (prev === null) return;
    if (votesForMe > prev) void playVoteReceived();
  }, [
    votes,
    definitions,
    room?.status,
    room?.id,
    room?.current_round,
    me?.id,
    playerId,
  ]);

  // Fallback global: se o coordenador for bot, qualquer navegador destrava a escolha
  const botAutopickRef = useRef<string | null>(null);
  useEffect(() => {
    if (!room || room.status !== "choosing" || room.current_word_id) return;
    if (!currentCoordinator?.is_bot) return;
    const key = `${room.id}:${room.current_round}:${room.current_coordinator}`;
    if (botAutopickRef.current === key) return;
    const timer = setTimeout(
      async () => {
        if (botAutopickRef.current === key) return;
        botAutopickRef.current = key;
        try {
          const options = await fetchThreeWords(
            room.used_word_ids ?? [],
            room.categories ?? [],
            room.id,
            room.nivel ?? "aleatorio",
          );
          if (!options.length) {
            botAutopickRef.current = null;
            return;
          }
          const pick = options[Math.floor(Math.random() * options.length)];
          await chooseWord(room.id, pick.id, 60, players.length);
        } catch (e) {
          console.error("bot global auto-pick failed", e);
          botAutopickRef.current = null;
        }
      },
      900 + Math.random() * 900,
    );
    return () => clearTimeout(timer);
  }, [
    room?.id,
    room?.status,
    room?.current_round,
    room?.current_coordinator,
    room?.current_word_id,
    currentCoordinator?.is_bot,
  ]);

  // Auto-rejoin para o host se o registro de jogador sumiu
  const autoJoinTriedRef = useRef(false);
  useEffect(() => {
    if (!room || !isHost || me || autoJoinTriedRef.current) return;
    autoJoinTriedRef.current = true;
    const nick = getStored<string>("nick", "Host");
    const avatar = getStored<string>("avatar", randomAvatar());
    const color = getStored<string>("color", randomColor());
    joinRoom(code, playerId, nick || "Host", avatar, color).catch((e) => {
      console.error("auto-join host failed", e);
      autoJoinTriedRef.current = false;
    });
  }, [room?.id, isHost, me, code, playerId]);

  // === Host migration ===
  const migrateTriedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!room || players.length === 0) return;
    const hostStillPresent = players.some((p) => p.id === room.host_id);
    if (hostStillPresent) {
      migrateTriedRef.current = null;
      return;
    }
    const humans = players
      .filter((p) => !p.is_bot)
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.joined_at ?? 0).getTime();
        const tb = new Date(b.joined_at ?? 0).getTime();
        if (ta !== tb) return ta - tb;
        return a.id.localeCompare(b.id);
      });
    const heir = humans[0];
    if (!heir || heir.id !== playerId) return;
    const key = `${room.id}:${room.host_id}->${heir.id}`;
    if (migrateTriedRef.current === key) return;
    migrateTriedRef.current = key;
    migrateHost(room.id, room.host_id, heir.id).then((ok) => {
      if (!ok) migrateTriedRef.current = null;
    });
  }, [room?.id, room?.host_id, players, playerId]);

  // Kicked notice
  const wasInGameRef = useRef(false);
  const [kickedNotice, setKickedNotice] = useState(false);
  useEffect(() => {
    if (!room) return;
    const inActivePhase = room.status !== "lobby" && room.status !== "finished";
    if (me && inActivePhase) wasInGameRef.current = true;
    if (!me && wasInGameRef.current && inActivePhase && !kickedNotice) {
      setKickedNotice(true);
    }
  }, [me, room?.status, kickedNotice]);

  // ============================================================
  // Fronteira de partida — auditoria de restart de partida
  // ============================================================
  // Vários refs deste componente persistem ENTRE matches porque RoomPage
  // não desmonta — apenas o filho-de-fase é trocado pelo <AnimatePresence>.
  // Sem reset explícito, dados de match anterior contaminavam match novo:
  //   * prevMyScoreRef = scoreFinal do match anterior → primeiro ponto do
  //     novo match não tocava playPointGained se score caía/igualava prev.
  //   * wasInGameRef ficava true → hiccup de presença em lobby/round 1
  //     disparava kickedNotice falso.
  //   * prevStatusRef carregava "finished" → playGameWin não tocava de novo
  //     ao terminar o 2º match (status já era finished antes do reset).
  //   * lastAttentionKeyRef/botAutopickRef ainda usavam chaves de rodadas
  //     do match anterior se o round-no-DB coincidisse (round 1 do match 2
  //     casa com round 1 do match 1 → effect curto-circuitava).
  // INVARIANTE: ao detectar fresh lobby (status='lobby' && round=0), zerar
  // todos os refs efêmeros e re-primar o áudio (clique de "Nova partida"
  // é user gesture válido para destravar AudioContext em iOS Safari).
  const matchBoundaryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!room) return;
    const isFreshLobby = room.status === "lobby" && room.current_round === 0;
    const gen = `${room.id}:${isFreshLobby ? "fresh" : "active"}`;
    if (matchBoundaryRef.current === null) {
      matchBoundaryRef.current = gen;
      return;
    }
    if (matchBoundaryRef.current === gen) return;
    const wasActive = matchBoundaryRef.current.endsWith(":active");
    matchBoundaryRef.current = gen;
    // Só reseta quando estamos VOLTANDO ao lobby de um match ativo (restart).
    if (!isFreshLobby || !wasActive) return;
    prevMyScoreRef.current = null;
    prevVotesForMeRef.current = null;
    prevVotingKeyRef.current = null;
    prevStatusRef.current = "lobby";
    lastAttentionKeyRef.current = null;
    botAutopickRef.current = null;
    wasInGameRef.current = false;
    setKickedNotice(false);
    void primeAudio();
  }, [room?.id, room?.status, room?.current_round]);

  if (kickedNotice) {
    const handleRejoin = async () => {
      try {
        const nick = getStored<string>("nick", "Jogador");
        const avatar = getStored<string>("avatar", randomAvatar());
        const color = getStored<string>("color", randomColor());
        await joinRoom(code, playerId, nick || "Jogador", avatar, color);
        setKickedNotice(false);
        wasInGameRef.current = false;
        reload();
      } catch (e) {
        console.error("rejoin failed", e);
      }
    };
    return (
      <div className="mobile-shell items-center justify-center text-center gap-4 p-6">
        <Mascot mood="sad" size={140} />
        <h2 className="font-display text-3xl text-pink">
          Você foi removido da partida
        </h2>
        <p className="text-base text-muted-foreground">
          Você perdeu pontos por não enviar a tempo nas 3 tentativas. Você pode
          voltar à sala — seus pontos atuais são mantidos.
        </p>
        <div className="flex flex-col gap-2 w-full max-w-xs">
          <button
            onClick={handleRejoin}
            className="btn-pop bg-gradient-fun text-white text-lg px-6 py-3"
          >
            ↩ Voltar para a partida
          </button>
          <button
            onClick={() => nav({ to: "/" })}
            className="btn-pop bg-muted text-foreground text-base px-6 py-2"
          >
            ← Voltar para a home
          </button>
        </div>
      </div>
    );
  }

  if (loading)
    return (
      <div className="mobile-shell items-center justify-center">
        <Mascot mood="thinking" />
        <p className="mt-4 font-display">Carregando sala…</p>
      </div>
    );
  if (error || !room) {
    return (
      <div className="mobile-shell items-center justify-center text-center gap-4">
        <Mascot mood="sad" />
        <h2 className="font-display text-2xl">Sala não encontrada</h2>
        <p className="text-muted-foreground text-sm">{error}</p>
        <button
          onClick={() => nav({ to: "/" })}
          className="btn-pop bg-gradient-fun text-white"
        >
          ← Voltar
        </button>
      </div>
    );
  }

  if (!me) {
    if (isHost) {
      return (
        <div className="mobile-shell items-center justify-center">
          <Mascot mood="thinking" />
          <p className="mt-4 font-display">Entrando na sala…</p>
        </div>
      );
    }
    return <JoinFlow code={code} roomId={room.id} status={room.status} />;
  }

  return (
    <div
      className="mobile-shell relative no-scrollbar"
      style={{
        height: "100dvh",
        maxHeight: "100dvh",
        minHeight: "100dvh",
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.5rem)",
        // Reserva espaço apenas para a barra de reações flutuante (~56px + safe-area)
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 60px)",
        overflow: "hidden",
        touchAction: "manipulation",
      }}
    >
      <TopBar
        code={room.code}
        round={room.current_round}
        status={room.status}
        isHost={isHost}
        onReload={reload}
        degraded={degraded}
        onReset={() => setConfirmReset(true)}
      />

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resetar o jogo?</AlertDialogTitle>
            <AlertDialogDescription>
              Todos os pontos voltam para zero e a sala volta ao lobby. Essa
              ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => restartGame(room.id)}>
              Sim, resetar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AnimatePresence mode="wait">
        <motion.div
          key={room.status}
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.99 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="flex-1 flex flex-col min-h-0"
          style={{ willChange: "transform, opacity" }}
        >
          <Suspense fallback={<PhaseFallback />}>
            {room.status === "lobby" && (
              <Lobby
                roomId={room.id}
                hostId={room.host_id}
                players={players}
                isHost={isHost}
                playerId={playerId}
                winCondition={room.win_condition}
                winTarget={room.win_target}
                mode={(room.mode as RoomMode) ?? "individual"}
                teams={room.teams ?? []}
                categories={room.categories ?? []}
                nivel={room.nivel ?? "aleatorio"}
              />
            )}
            {room.status === "choosing" && (
              <ChooseWord
                room={room}
                players={players}
                isCoordinator={room.current_coordinator === playerId}
              />
            )}
            {room.status === "writing" && word && (
              <WriteDefinition
                room={room}
                players={players}
                word={word}
                me={me}
                isCoordinator={room.current_coordinator === playerId}
                definitions={definitions}
                roundExtensions={roundExtensions}
                isHost={isHost}
                isDeputy={isDeputy}
              />
            )}
            {room.status === "shuffling" && word && (
              <Shuffling
                room={room}
                word={word}
                definitions={definitions}
                isHost={isHost}
              />
            )}
            {room.status === "voting" && word && (
              <Voting
                room={room}
                players={players}
                word={word}
                definitions={definitions}
                votes={votes}
                me={me}
                isHost={isHost}
                isDeputy={isDeputy}
                roundExtensions={roundExtensions}
              />
            )}
            {room.status === "reveal" && word && (
              <Reveal
                room={room}
                players={players}
                word={word}
                definitions={definitions}
                votes={votes}
                isHost={isHost}
              />
            )}
            {room.status === "scoreboard" && (
              <Scoreboard room={room} players={players} isHost={isHost} />
            )}
            {room.status === "finished" && (
              <Finished
                room={room}
                players={players}
                isHost={isHost}
                roomId={room.id}
                roomCode={room.code}
                playerId={playerId}
                onLeave={() => {
                  leaveRoom(playerId);
                  nav({ to: "/" });
                }}
              />
            )}
          </Suspense>
        </motion.div>
      </AnimatePresence>

      <PhaseAnnouncer status={room.status} />
      <ReactionsLayer roomId={room.id} playerId={playerId} />
      <RoomChat
        roomId={room.id}
        status={room.status}
        playerId={playerId}
        players={players}
      />
    </div>
  );
}
