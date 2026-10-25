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
import { botPickDelayMs } from "@/lib/game-times";
import { shuffleScreenHoldUntil } from "@/lib/transition-floor";
import { usePausePresence } from "@/hooks/room/use-pause-presence";
import { PausedBanner } from "@/components/room/PausedBanner";
import {
  fetchThreeWords,
  chooseWord,
  joinRoom,
  leaveRoom,
  restartGame,
  migrateHost,
  type RoomMode,
  type Word,
} from "@/lib/room";
import { drawFittingWords } from "@/lib/word-fit";
import { randomAvatar, randomColor } from "@/lib/avatars";
import { Mascot } from "@/components/Mascot";
import { ReactionsLayer } from "@/components/ReactionsLayer";
import {
  PhaseAnnouncer,
  PHASE_ANNOUNCER_TOTAL_MS,
} from "@/components/room/PhaseAnnouncer";
import {
  playAlert,
  primeAudio,
  playGameWin,
  playPointMagnitude,
  playVoteReceived,
  playWhooshUp,
  playStreak,
} from "@/lib/sound";
import { setMusicMood, stopMusic } from "@/lib/music";

import { TopBar } from "@/components/room/TopBar";
import { MesaSidebar } from "@/components/room/MesaSidebar";
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
        // Os sons da revelação saem da própria Reveal, um por passo da
        // coreografia ("verdade primeiro", 2026-10-20) — aqui só a trilha.
        setMusicMood("reveal");
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

  // Coordenador bot: o HOST sorteia e escolhe; os demais navegadores só
  // destravam se o host não fizer (antes TODOS sorteavam e chamavam
  // chooseWord ao mesmo tempo — N buscas e N escolhas duplicadas por rodada,
  // auditoria de 2026-10-20). A RPC aceita só a primeira escolha. A escolha
  // espera a cortina + a tela do coordenador ficar legível (botPickDelayMs);
  // as palavras já vêm sendo buscadas durante a espera. Sala pausada não
  // escolhe nada.
  const botAutopickRef = useRef<string | null>(null);
  // Âncora da escolha do bot: o instante em que ESTE navegador viu a rodada
  // entrar na escolha. Trocar o coordenador depois disso não reinicia a
  // conta (antes, provisório → autoritativo dava ~5,1 s de tela na 1ª rodada).
  // Piso do embaralhamento NESTE aparelho (2026-10-22): a votação só toma o
  // lugar do "Embaralhando" depois de ele ficar NARRATIVE_MIN_VISIBLE_MS à
  // vista aqui (quem o recebe atrasado via ~2,3 s).
  const shuffleSeenRef = useRef<{ key: string; at: number } | null>(null);
  const roundKey = room ? `${room.id}:${room.current_round}` : "";
  if (room?.status === "shuffling" && shuffleSeenRef.current?.key !== roundKey)
    shuffleSeenRef.current = { key: roundKey, at: Date.now() };
  const shuffleHoldUntil = room
    ? shuffleScreenHoldUntil(room.status, shuffleSeenRef.current, roundKey)
    : 0;
  const [, bumpScreen] = useState(0);
  useEffect(() => {
    const wait = shuffleHoldUntil - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => bumpScreen((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [shuffleHoldUntil]);
  const screenStatus =
    shuffleHoldUntil > Date.now() ? "shuffling" : room?.status;
  const choosingSeenRef = useRef<{ key: string; at: number } | null>(null);
  // Partida nova (2026-10-22): a rodada 1 do match seguinte tem a mesma chave
  // da rodada 1 do anterior — sem zerar aqui (mesmo que o lobby passe batido
  // entre duas leituras), o bot escolhia na hora, ainda sob a cortina.
  if (room?.status === "lobby" || room?.status === "finished") {
    choosingSeenRef.current = null;
    botAutopickRef.current = null;
  }
  if (room?.status === "choosing") {
    const seenKey = `${room.id}:${room.current_round}`;
    if (choosingSeenRef.current?.key !== seenKey)
      choosingSeenRef.current = { key: seenKey, at: Date.now() };
  }
  useEffect(() => {
    if (!room || room.status !== "choosing" || room.current_word_id) return;
    if (!currentCoordinator?.is_bot || room.paused_at) return;
    // uma escolha por RODADA (não por coordenador)
    const key = `${room.id}:${room.current_round}`;
    const seen = choosingSeenRef.current;
    const elapsed = seen?.key === key ? Date.now() - seen.at : 0;
    if (botAutopickRef.current === key) return;
    // Só o host busca já (N navegadores buscando por rodada era o problema
    // de 2026-10-20); quem cobre a falta dele busca na hora.
    // Mesmo filtro da escolha humana: só palavras que cabem inteiras na tela
    // (lib/word-fit.ts) — o bot nunca escolhe "Gastroenterol…".
    const fetchWords = () =>
      drawFittingWords({
        fetch: (seen) =>
          fetchThreeWords(
            [...(room.used_word_ids ?? []), ...seen],
            room.categories ?? [],
            room.id,
            room.nivel ?? "aleatorio",
            9,
          ),
      })
        .then((r) => r.words)
        .catch(() => [] as Word[]);
    const words = isHost ? fetchWords() : null;
    const timer = setTimeout(
      async () => {
        if (botAutopickRef.current === key) return;
        botAutopickRef.current = key;
        try {
          const options = await (words ?? fetchWords());
          if (!options.length) {
            botAutopickRef.current = null;
            return;
          }
          const pick = options[Math.floor(Math.random() * options.length)]!;
          await chooseWord(room.id, pick.id, 60, players.length, {
            optimistic: isHost,
          });
        } catch (e) {
          console.error("bot global auto-pick failed", e);
          botAutopickRef.current = null;
        }
      },
      Math.max(0, botPickDelayMs(isHost, PHASE_ANNOUNCER_TOTAL_MS) - elapsed) +
        (isHost ? 0 : Math.random() * 900),
    );
    return () => clearTimeout(timer);
  }, [
    room?.id,
    room?.status,
    room?.current_round,
    room?.current_coordinator,
    room?.current_word_id,
    room?.paused_at,
    currentCoordinator?.is_bot,
    isHost,
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
    migrateHost(room.id).then((ok) => {
      if (!ok) migrateTriedRef.current = null;
    });
  }, [room?.id, room?.host_id, players, playerId]);

  // Pausa de partida: presença do jogador (toque/tela) para o servidor saber
  // se a mesa inteira saiu antes de punir alguém pelo prazo.
  usePausePresence({
    roomId: room?.id,
    playerId,
    // desde o lobby: o registro de presença nasce na entrada e marca o
    // cliente novo (humano sem registro = cliente antigo, nunca pausa)
    inGame: !!room && room.status !== "finished",
    activeHuman: !!me && !me.is_bot,
  });

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
            className="btn-pop btn-gold text-lg px-6 py-3"
          >
            ↩ Voltar para a partida
          </button>
          <button
            onClick={() => nav({ to: "/" })}
            className="btn-pop btn-plain text-base px-6 py-2"
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
        <button onClick={() => nav({ to: "/" })} className="btn-pop btn-gold">
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

  // Desktop: o "Placar ao vivo" acompanha as fases de jogo; lobby,
  // placar e pódio já são a própria tabela de jogadores.
  const showMesa =
    room.status !== "lobby" &&
    room.status !== "scoreboard" &&
    room.status !== "finished";

  return (
    <div
      className="mobile-shell stage-wide room-shell relative no-scrollbar"
      style={{
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.5rem)",
        // Reserva só a faixa da barra de reações compacta (--dock-h, styles.css)
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + var(--dock-h))",
        overflow: "hidden",
        touchAction: "manipulation",
      }}
    >
      <TopBar
        code={room.code}
        round={room.current_round}
        roundsTotal={
          room.win_condition === "rounds" ? room.win_target : undefined
        }
        status={room.status}
        isHost={isHost}
        onReload={reload}
        degraded={degraded}
        onReset={() => setConfirmReset(true)}
      />
      {room.paused_at &&
        (room.status === "writing" || room.status === "voting") && (
          <PausedBanner
            roomId={room.id}
            playerId={playerId}
            canResume={!!me && !me.is_bot}
          />
        )}

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
            <AlertDialogAction
              onClick={() => restartGame(room.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Sim, resetar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex-1 min-h-0 flex lg:gap-6">
        <div
          className={
            "flex-1 min-w-0 min-h-0 flex flex-col w-full mx-auto " +
            (room.status === "lobby" ||
            room.status === "finished" ||
            room.status === "scoreboard"
              ? "lg:max-w-[1080px]"
              : "lg:max-w-[820px]")
          }
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={screenStatus}
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
                {screenStatus === "shuffling" && word && (
                  <Shuffling
                    room={room}
                    word={word}
                    definitions={definitions}
                    isHost={isHost}
                    onShown={() => {
                      // o piso conta de quando a tela montou (depois da
                      // saída animada da escrita), não da virada da fase
                      shuffleSeenRef.current = {
                        key: roundKey,
                        at: Date.now(),
                      };
                    }}
                  />
                )}
                {screenStatus === "voting" && word && (
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
        </div>
        {showMesa && (
          <MesaSidebar
            room={room}
            players={players}
            definitions={definitions}
            votes={votes}
            playerId={playerId}
          />
        )}
      </div>

      <PhaseAnnouncer status={room.status} round={room.current_round} />
      <ReactionsLayer roomId={room.id} playerId={playerId} />
    </div>
  );
}
