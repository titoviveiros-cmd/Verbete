import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  addBot,
  kickPlayer,
  setWinCondition,
  startGame,
  setRoomMode,
  setRoomTeams,
  assignPlayerToTeam,
  autoBalanceTeams,
  setCategories,
  setNivel,
  TEAM_PRESETS,
  type Player,
  type Room,
  type Team,
  type RoomMode,
  type NivelFilter,
} from "@/lib/room";
import { AvatarBubble } from "@/components/AvatarBubble";
import { ReportPlayerButton } from "@/components/room/ReportPlayerButton";
import { Mascot } from "@/components/Mascot";
import { roomInviteUrl } from "@/lib/app-url";
import { shareInvite } from "@/lib/share";
import { playJoin, playBotJoin, playKick, playUITap } from "@/lib/sound";
import { scrollbarClip } from "@/lib/utils";
import {
  activeCount,
  botsToMinimum,
  canStartGame,
  startButtonLabel,
} from "@/lib/game-rules";

export const CATEGORY_META: Record<string, { emoji: string; label: string }> = {
  // Categorias enxutas (pedido do usuário 2026-07-19: natureza, história,
  // cotidiano, comportamento, ações e religião saíram do filtro — as
  // palavras continuam entrando pelo "Todas").
  infantil: { emoji: "🧒", label: "Infantil" },
  gastronomia: { emoji: "🍲", label: "Gastronomia" },
  ciencia: { emoji: "🔬", label: "Ciência" },
  planta: { emoji: "🌱", label: "Plantas" },
  animal: { emoji: "🐾", label: "Animais" },
  corpo: { emoji: "🫀", label: "Corpo" },
  sentimento: { emoji: "💗", label: "Sentimentos" },
  lugar: { emoji: "📍", label: "Lugares" },
  qualidade: { emoji: "✨", label: "Qualidades" },
  adjetivo: { emoji: "🎨", label: "Adjetivos" },
  verbo: { emoji: "🏃", label: "Verbos" },
  direito: { emoji: "⚖️", label: "Direito" },
  medicina: { emoji: "🩺", label: "Medicina" },
  literatura: { emoji: "📚", label: "Literatura" },
  nautica: { emoji: "⚓", label: "Náutica" },
};

export const NIVEL_META: Array<{
  value: NivelFilter;
  emoji: string;
  label: string;
}> = [
  { value: "aleatorio", emoji: "🎲", label: "Aleatório" },
  { value: "facil", emoji: "🟢", label: "Fácil" },
  { value: "medio", emoji: "🟡", label: "Médio" },
  { value: "dificil", emoji: "🟠", label: "Difícil" },
  { value: "insano", emoji: "🔴", label: "Insano" },
];

export function Lobby({
  roomId,
  hostId,
  players,
  isHost,
  playerId,
  winCondition,
  winTarget,
  mode,
  teams,
  categories,
  nivel = "aleatorio",
}: {
  roomId: string;
  hostId: string;
  players: Player[];
  isHost: boolean;
  playerId: string;
  winCondition: string;
  winTarget: number;
  mode: RoomMode;
  teams: Team[];
  categories: string[];
  nivel?: NivelFilter;
}) {
  const slotsLeft = Math.max(0, 12 - players.length);
  // Mínimo de 4 participantes ativos (humanos + bots) — o servidor
  // (start_game) recusa abaixo disso; aqui só se evita o clique inútil.
  const canStart = canStartGame(players);
  const humans = players.filter((p) => !p.is_bot).length;
  const botsNeeded = botsToMinimum(players);
  const [copied, setCopied] = useState(false);
  const [shareWarn, setShareWarn] = useState<string | null>(null);
  const code = location.pathname.split("/").pop() ?? "";

  const prevIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(players.map((p) => p.id));
    const prev = prevIdsRef.current;
    if (prev) {
      const newPlayers = players.filter(
        (p) => !prev.has(p.id) && p.id !== playerId,
      );
      if (newPlayers.length > 0) {
        if (newPlayers.some((p) => !p.is_bot)) void playJoin();
        else void playBotJoin();
      }
      const removed = [...prev].filter((id) => !ids.has(id) && id !== playerId);
      if (removed.length > 0) void playKick();
    }
    prevIdsRef.current = ids;
  }, [players, playerId]);

  const handleShare = async () => {
    // Link público canônico (nunca location.origin: no app nativo ele é
    // https://localhost).
    const url = roomInviteUrl(code);
    setShareWarn(null);
    const outcome = await shareInvite({
      title: "Verbete",
      text: `Bora jogar Verbete? Sala ${code} 👇`,
      url,
    });
    if (outcome === "copied") {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } else if (outcome === "failed") {
      setShareWarn(
        `Não deu para abrir o compartilhamento. Link da sala: ${url}`,
      );
    }
  };

  // Ação da sala (host: Começar; convidado: aguardando). No desktop fica na
  // grade, sob os jogadores; no celular e no tablet, num rodapé fino e fixo
  // — a lista de opções rola acima dele (playtest 2026-10-20).
  const action = isHost ? (
    <StartButton
      canStart={canStart}
      playersCount={activeCount(players)}
      roomId={roomId}
      players={players}
      mode={mode}
      teams={teams}
    />
  ) : (
    <div className="panel text-center text-muted-foreground font-display py-2.5 text-sm">
      {mode === "teams" &&
        (() => {
          const myTeam = teams.find(
            (t) => t.id === players.find((p) => p.id === playerId)?.team_id,
          );
          return myTeam ? (
            <p className="mb-1 font-display" style={{ color: myTeam.color }}>
              {myTeam.emoji} Você está no time {myTeam.name}
            </p>
          ) : (
            <p className="mb-1 text-pink">
              ⏳ Aguardando o host te colocar num time…
            </p>
          );
        })()}
      Aguardando o host iniciar…
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flex-1 flex flex-col min-h-0"
    >
      <div
        className="flex-1 flex flex-col gap-3 min-h-0 overflow-y-auto no-scrollbar pb-2 lg:grid lg:grid-cols-[1.05fr_0.95fr] lg:grid-rows-[auto_1fr] lg:gap-x-6 lg:gap-y-3 lg:content-center"
        style={scrollbarClip()}
      >
        <div className="flex flex-col gap-3 min-w-0 lg:col-start-1 lg:row-start-1">
          {/* "Chame a galera!" nunca corta (saía "Chame a ga…" com o
            Compartilhar ao lado — playtest 2026-10-20): no celular o botão
            ganha a linha de baixo inteira; do tablet para cima, lado a lado. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5 panel px-3 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <Mascot mood="idle" size={58} className="max-[389px]:hidden" />
              <div className="min-w-0">
                <p className="eyebrow">Sala de espera</p>
                <p className="font-display text-lg leading-tight whitespace-nowrap">
                  Chame a galera!
                </p>
              </div>
            </div>
            <button
              onClick={handleShare}
              className="btn-pop btn-gold py-2.5 !px-3.5 text-base shrink-0 max-[519px]:basis-full"
            >
              {copied ? "✅ Copiado!" : "📲 Compartilhar"}
            </button>
          </div>
          {shareWarn && (
            <p className="text-[11px] text-pink text-center font-display leading-tight">
              {shareWarn}
            </p>
          )}

          <div className="panel p-3 flex flex-col shrink-0">
            <div className="flex items-center justify-between gap-2 mb-2 px-1">
              <h3 className="eyebrow">Jogadores ({players.length}/12)</h3>
              <ReportPlayerButton players={players} meId={playerId} />
            </div>
            <div className="grid grid-cols-4 lg:grid-cols-6 gap-x-2 gap-y-3 content-start pt-1 px-1">
              {[...players]
                .sort((a, b) => {
                  const aHost = a.id === hostId ? 0 : 1;
                  const bHost = b.id === hostId ? 0 : 1;
                  if (aHost !== bHost) return aHost - bHost;
                  return (a.joined_at ?? "").localeCompare(b.joined_at ?? "");
                })
                .map((p) => {
                  const team =
                    mode === "teams"
                      ? teams.find((t) => t.id === p.team_id)
                      : undefined;
                  return (
                    <div key={p.id} className="relative w-[52px] mx-auto">
                      <AvatarBubble
                        emoji={p.avatar}
                        color={p.color}
                        size={52}
                        label={(p.is_bot ? "🤖 " : "") + p.nickname}
                        isYou={p.id === playerId}
                      />
                      {isHost && p.id !== playerId && (
                        <button
                          onClick={() => kickPlayer(roomId, playerId, p.id)}
                          aria-label={`Remover ${p.nickname} da sala`}
                          className="absolute -top-0.5 right-0 w-5 h-5 bg-destructive text-white rounded-full text-[11px] font-bold leading-none flex items-center justify-center border-2 border-[var(--c-night)]"
                        >
                          <span aria-hidden="true">×</span>
                        </button>
                      )}
                      {mode === "teams" && (
                        <div
                          className="mt-1 text-[9px] leading-none text-center font-display truncate"
                          style={{
                            color: team?.color ?? "rgba(255,255,255,0.4)",
                          }}
                        >
                          {team ? `${team.emoji} ${team.name}` : "— sem time"}
                        </div>
                      )}
                    </div>
                  );
                })}
              {Array.from({ length: slotsLeft }).map((_, i) => (
                <div
                  key={"e" + i}
                  className="flex items-center justify-center w-[52px] h-[52px] mx-auto rounded-full border-2 border-dashed border-[var(--c-line)] text-[var(--c-faint)] opacity-70 text-base"
                >
                  ?
                </div>
              ))}
            </div>
          </div>

          {players.length < 12 && (
            <div className="rounded-2xl bg-mint/[0.07] border border-mint/30 p-3 text-center space-y-2">
              <p className="text-[12px] font-bold text-mint leading-tight">
                {players.length < 4
                  ? `Adicione +${4 - players.length} ${4 - players.length === 1 ? "jogador ou bot" : "jogadores ou bots"} para começar`
                  : `Quer mais caos? Adicione bots (até 12)`}
              </p>
              <div className="flex justify-center gap-1.5 flex-wrap">
                <button
                  onClick={() => addBot(roomId, playerId, players.length)}
                  disabled={players.length >= 12}
                  className="btn-pop btn-turq py-2 px-3.5 text-sm flex items-center gap-1"
                >
                  <span className="text-sm leading-none">🤖</span> +1 Bot
                </button>
                {botsNeeded > 1 && (
                  <button
                    onClick={() => {
                      for (let i = 0; i < botsNeeded; i++) {
                        addBot(roomId, playerId, players.length + i);
                      }
                    }}
                    className="btn-pop btn-turq py-2 px-3.5 text-sm"
                  >
                    Encher até 4 (+{botsNeeded} 🤖)
                  </button>
                )}
              </div>
              {humans === 1 && players.length < 4 && (
                <p className="text-[11px] text-muted-foreground leading-tight">
                  Dica: convide amigos pelo botão acima 👆
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3 min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2">
          {isHost && (
            <div className="panel p-3.5 space-y-3">
              <ModeAndTeamsConfig
                roomId={roomId}
                actorId={playerId}
                mode={mode}
                teams={teams}
                players={players}
              />

              <div className="space-y-1.5">
                <p className="eyebrow text-center">Como termina a partida?</p>
                <div className="flex gap-1.5">
                  <button
                    onClick={() =>
                      setWinCondition(
                        roomId,
                        playerId,
                        "rounds",
                        winCondition === "rounds" ? winTarget : 10,
                      )
                    }
                    aria-pressed={winCondition === "rounds"}
                    className={
                      "seg flex-1 py-2 text-[12px] leading-tight " +
                      (winCondition === "rounds" ? "seg-on" : "")
                    }
                  >
                    <div>
                      {winCondition === "rounds"
                        ? `${winTarget} rodadas`
                        : "Rodadas"}
                    </div>
                    <div className="text-[9px] opacity-80 normal-case">
                      número fixo
                    </div>
                  </button>
                  <button
                    onClick={() =>
                      setWinCondition(
                        roomId,
                        playerId,
                        "score",
                        winCondition === "score" ? winTarget : 15,
                      )
                    }
                    aria-pressed={winCondition === "score"}
                    className={
                      "seg flex-1 py-2 text-[12px] leading-tight " +
                      (winCondition === "score" ? "seg-on" : "")
                    }
                  >
                    <div>
                      {winCondition === "score"
                        ? `${winTarget} pts`
                        : "Pontuação"}
                    </div>
                    <div className="text-[9px] opacity-80 normal-case">
                      quem chegar 1º
                    </div>
                  </button>
                </div>

                {winCondition === "rounds" && (
                  <div className="flex gap-1.5 pt-0.5">
                    {[5, 10, 15, 20].map((n) => (
                      <button
                        key={n}
                        onClick={() =>
                          setWinCondition(roomId, playerId, "rounds", n)
                        }
                        aria-pressed={winTarget === n}
                        className={
                          "seg flex-1 py-1.5 text-[11px] " +
                          (winTarget === n ? "seg-on" : "")
                        }
                      >
                        {n} rod.
                      </button>
                    ))}
                  </div>
                )}

                {winCondition === "score" && (
                  <div className="flex gap-1.5 pt-0.5">
                    {[15, 20, 30, 50].map((n) => (
                      <button
                        key={n}
                        onClick={() =>
                          setWinCondition(roomId, playerId, "score", n)
                        }
                        aria-pressed={winTarget === n}
                        className={
                          "seg flex-1 py-1.5 text-[11px] " +
                          (winTarget === n ? "seg-on" : "")
                        }
                      >
                        {n} pts
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <p className="eyebrow text-center">Nível das palavras</p>
                <div className="flex gap-1">
                  {NIVEL_META.map((n) => (
                    <button
                      key={n.value}
                      onClick={() => {
                        void playUITap();
                        setNivel(roomId, playerId, n.value);
                      }}
                      aria-pressed={nivel === n.value}
                      className={
                        "seg flex-1 py-1.5 text-[11px] leading-tight " +
                        (nivel === n.value ? "seg-on" : "")
                      }
                    >
                      <div>{n.emoji}</div>
                      <div>{n.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              <CategoriesPicker
                roomId={roomId}
                actorId={playerId}
                selected={categories}
              />

              {/* "Palavras próprias" removida do lobby a pedido (2026-07-19);
              backend room_words segue intacto para eventual retorno. */}
            </div>
          )}

          {!isHost && categories.length > 0 && (
            <div className="panel p-2.5 text-center">
              <p className="eyebrow">Categorias</p>
              <p className="text-[11px] text-foreground/80 mt-0.5">
                {categories
                  .map((c) => CATEGORY_META[c]?.emoji ?? "🏷️")
                  .join(" ")}{" "}
                <span className="text-muted-foreground">
                  ({categories.length})
                </span>
              </p>
            </div>
          )}
        </div>
        {/* Ação da sala: no desktop fica sob os jogadores (sempre à vista);
          no celular continua no fim, depois das opções. */}
        <div className="flex flex-col gap-3 min-w-0 lg:col-start-1 lg:row-start-2 lg:self-start">
          {/* desktop (e celular deitado, sem altura para um rodapé fixo) */}
          <div className="hidden lg:block short:block">{action}</div>
          {/* Voltar ao início (pedido 2026-07-21) — o 🚪 do topo continua
          existindo; este é o caminho explícito e sem fricção no lobby. */}
          <Link
            to="/"
            className="glass-tile self-center mt-1 mb-2 flex items-center gap-1.5 text-sm font-display px-4 py-2 rounded-full transition text-muted-foreground"
          >
            ← Voltar para o início
          </Link>
        </div>
      </div>
      <div className="shrink-0 flex flex-col justify-center pt-1.5 lg:hidden short:hidden">
        {action}
      </div>
    </motion.div>
  );
}

function CategoriesPicker({
  roomId,
  actorId,
  selected,
}: {
  roomId: string;
  actorId: string;
  selected: string[];
}) {
  const toggle = (cat: string) => {
    const next = selected.includes(cat)
      ? selected.filter((c) => c !== cat)
      : [...selected, cat];
    void setCategories(roomId, actorId, next);
  };
  const clear = () => {
    if (selected.length === 0) return;
    void setCategories(roomId, actorId, []);
  };
  const entries = Object.entries(CATEGORY_META);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-1">
        <p className="eyebrow">
          Categorias{" "}
          {selected.length > 0 && (
            <span className="text-foreground/70">({selected.length})</span>
          )}
        </p>
        <button
          onClick={clear}
          className="text-[10px] font-display uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-40"
          disabled={selected.length === 0}
        >
          Todas
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {entries.map(([cat, meta]) => {
          const on = selected.includes(cat);
          return (
            <button
              key={cat}
              onClick={() => toggle(cat)}
              aria-pressed={on}
              className={
                "seg py-1.5 text-[11px] leading-tight flex flex-col items-center gap-0.5 " +
                (on ? "seg-on" : "")
              }
            >
              <span className="text-sm leading-none">{meta.emoji}</span>
              <span className="truncate w-full text-center">{meta.label}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[9px] text-muted-foreground text-center font-display">
        {selected.length === 0
          ? "Sem filtro: todas as palavras entram no sorteio."
          : "Apenas palavras das categorias marcadas serão sorteadas."}
      </p>
    </div>
  );
}

function ModeAndTeamsConfig({
  roomId,
  actorId,
  mode,
  teams,
  players,
}: {
  roomId: string;
  actorId: string;
  mode: RoomMode;
  teams: Team[];
  players: Player[];
}) {
  const switchMode = (next: RoomMode) => {
    if (next === mode) return;
    const initial =
      next === "teams" && teams.length === 0
        ? TEAM_PRESETS["men-women"]
        : teams;
    void setRoomMode(roomId, actorId, next, initial);
  };
  const applyPreset = (key: keyof typeof TEAM_PRESETS) => {
    void setRoomTeams(roomId, actorId, TEAM_PRESETS[key]!);
    players.forEach((p) => assignPlayerToTeam(roomId, actorId, p.id, null));
  };
  return (
    <div className="space-y-1.5">
      <p className="eyebrow text-center">Modo de jogo</p>
      <div className="flex gap-1.5">
        <button
          onClick={() => switchMode("individual")}
          aria-pressed={mode === "individual"}
          className={
            "seg flex-1 py-2 text-[12px] leading-tight " +
            (mode === "individual" ? "seg-on" : "")
          }
        >
          🙋 Individual
        </button>
        <button
          onClick={() => switchMode("teams")}
          aria-pressed={mode === "teams"}
          className={
            "seg flex-1 py-2 text-[12px] leading-tight " +
            (mode === "teams" ? "seg-on" : "")
          }
        >
          👥 Equipes
        </button>
      </div>
      {mode === "teams" &&
        (() => {
          const activePreset: keyof typeof TEAM_PRESETS | null =
            teams.length === 2 && teams[0]?.id === "men"
              ? "men-women"
              : teams.length === 2 && teams[0]?.id === "a"
                ? "ab"
                : teams.length === 3
                  ? "abc"
                  : null;
          const presetBtn = (key: keyof typeof TEAM_PRESETS, label: string) => (
            <button
              onClick={() => applyPreset(key)}
              aria-pressed={activePreset === key}
              className={
                "seg flex-1 py-1.5 text-[11px] leading-tight " +
                (activePreset === key ? "seg-on" : "")
              }
            >
              {label}
            </button>
          );
          return (
            <div className="space-y-1.5 pt-1">
              <div className="flex gap-1.5">
                {presetBtn("men-women", "👨×👩 Homens×Mulheres")}
                {presetBtn("ab", "🅰️×🅱️ A×B")}
                {presetBtn("abc", "3 times")}
              </div>
              <button
                onClick={() =>
                  autoBalanceTeams(roomId, actorId, players, teams)
                }
                className="btn-pop btn-turq w-full !py-2 text-[12px]"
              >
                ⚖️ Distribuir automaticamente
              </button>
              <div className="space-y-1 pt-1">
                <p className="eyebrow">Toque num jogador para mudar de time:</p>
                {players.map((p) => {
                  const currentTeam = teams.find((t) => t.id === p.team_id);
                  const nextTeam = (() => {
                    const idx = teams.findIndex((t) => t.id === p.team_id);
                    return teams[(idx + 1) % teams.length];
                  })();
                  return (
                    <button
                      key={p.id}
                      onClick={() =>
                        assignPlayerToTeam(
                          roomId,
                          actorId,
                          p.id,
                          nextTeam?.id ?? null,
                        )
                      }
                      className="seg w-full flex items-center gap-2 px-2 py-1.5 text-[12px]"
                    >
                      <span className="text-base">{p.avatar}</span>
                      <span className="font-display flex-1 text-left truncate">
                        {p.nickname}
                        {p.is_bot ? " 🤖" : ""}
                      </span>
                      {currentTeam ? (
                        <span
                          className="font-display px-2 py-0.5 rounded-full"
                          style={{
                            background: currentTeam.color + "33",
                            color: currentTeam.color,
                            border: "1px solid " + currentTeam.color + "66",
                          }}
                        >
                          {currentTeam.emoji} {currentTeam.name}
                        </span>
                      ) : (
                        <span className="font-display px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-muted-foreground">
                          — sem time
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
    </div>
  );
}

function StartButton({
  canStart,
  playersCount,
  roomId,
  players,
  mode,
  teams,
}: {
  canStart: boolean;
  playersCount: number;
  roomId: string;
  players: Player[];
  mode: RoomMode;
  teams: Team[];
}) {
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (!refused) return;
    const t = setTimeout(() => setRefused(false), 3000);
    return () => clearTimeout(t);
  }, [refused]);
  const teamsOK =
    mode !== "teams" ||
    (teams.length >= 2 && players.every((p) => !!p.team_id));
  const allOK = canStart && teamsOK;
  const onClick = async () => {
    if (starting || !allOK) return;
    void playUITap("primary");
    setStarting(true);
    try {
      await startGame({ id: roomId, current_coordinator: null } as Room);
    } catch (e) {
      console.error(e);
      setStarting(false);
      // Recusa por mesa incompleta: em geral o bot otimista ainda não chegou
      // ao banco (clique logo depois de "Encher até 4") — explica no botão.
      if (String(e).includes("min_players")) setRefused(true);
    }
  };
  const label = startButtonLabel({
    count: playersCount,
    starting,
    teamsOK,
    refused,
  });
  return (
    <button
      disabled={!allOK || starting}
      onClick={onClick}
      className="btn-pop btn-gold w-full text-lg leading-tight text-balance !py-3"
    >
      {label}
    </button>
  );
}

export default Lobby;
