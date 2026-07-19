import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  addBot, kickPlayer, setWinCondition, startGame,
  setRoomMode, setRoomTeams, assignPlayerToTeam, autoBalanceTeams, setCategories, setNivel,
  fetchRoomWords, addRoomWord, deleteRoomWord,
  TEAM_PRESETS, type Player, type Room, type Team, type RoomMode, type RoomWord, type NivelFilter,
} from "@/lib/room";
import { AvatarBubble } from "@/components/AvatarBubble";
import { Mascot } from "@/components/Mascot";
import { playJoin, playBotJoin, playKick, playUITap } from "@/lib/sound";

export const CATEGORY_META: Record<string, { emoji: string; label: string }> = {
  // Categorias enxutas (pedido do usuário 2026-07-19: natureza, história,
  // cotidiano, comportamento, ações e religião saíram do filtro — as
  // palavras continuam entrando pelo "Todas").
  infantil:      { emoji: "🧒", label: "Infantil" },
  gastronomia:   { emoji: "🍲", label: "Gastronomia" },
  ciencia:       { emoji: "🔬", label: "Ciência" },
  planta:        { emoji: "🌱", label: "Plantas" },
  animal:        { emoji: "🐾", label: "Animais" },
  corpo:         { emoji: "🫀", label: "Corpo" },
  objeto:        { emoji: "🧰", label: "Objetos" },
  sentimento:    { emoji: "💗", label: "Sentimentos" },
  regional:      { emoji: "🗺️", label: "Regional" },
  pessoa:        { emoji: "🧑", label: "Pessoas" },
  lugar:         { emoji: "📍", label: "Lugares" },
  qualidade:     { emoji: "✨", label: "Qualidades" },
  adjetivo:      { emoji: "🎨", label: "Adjetivos" },
  verbo:         { emoji: "🏃", label: "Verbos" },
  direito:       { emoji: "⚖️", label: "Direito" },
  medicina:      { emoji: "🩺", label: "Medicina" },
  literatura:    { emoji: "📚", label: "Literatura" },
  nautica:       { emoji: "⚓", label: "Náutica" },
};

export const NIVEL_META: Array<{ value: NivelFilter; emoji: string; label: string }> = [
  { value: "aleatorio", emoji: "🎲", label: "Aleatório" },
  { value: "facil",     emoji: "🟢", label: "Fácil" },
  { value: "medio",     emoji: "🟡", label: "Médio" },
  { value: "dificil",   emoji: "🟠", label: "Difícil" },
  { value: "insano",    emoji: "🔴", label: "Insano" },
];

export function Lobby({
  roomId, hostId, players, isHost, playerId, winCondition, winTarget, mode, teams, categories, nivel = "aleatorio",
}: { roomId: string; hostId: string; players: Player[]; isHost: boolean; playerId: string; winCondition: string; winTarget: number; mode: RoomMode; teams: Team[]; categories: string[]; nivel?: NivelFilter; }) {
  const slotsLeft = Math.max(0, 12 - players.length);
  const canStart = players.length >= 2;
  const humans = players.filter((p) => !p.is_bot).length;
  const botsNeeded = Math.max(0, 4 - players.length);
  const [copied, setCopied] = useState(false);
  const [shareWarn, setShareWarn] = useState<string | null>(null);
  const code = location.pathname.split("/").pop() ?? "";

  const prevIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(players.map((p) => p.id));
    const prev = prevIdsRef.current;
    if (prev) {
      const newPlayers = players.filter((p) => !prev.has(p.id) && p.id !== playerId);
      if (newPlayers.length > 0) {
        if (newPlayers.some((p) => !p.is_bot)) void playJoin();
        else void playBotJoin();
      }
      const removed = [...prev].filter((id) => !ids.has(id) && id !== playerId);
      if (removed.length > 0) void playKick();
    }
    prevIdsRef.current = ids;
  }, [players, playerId]);

  const buildShareUrl = () => {
    const host = location.hostname;
    const isPreviewHost =
      /^id-preview--[0-9a-f-]+\.lovable\.app$/i.test(host) ||
      /\.lovableproject\.com$/i.test(host) ||
      host === "localhost" ||
      host.startsWith("127.");
    if (isPreviewHost) {
      return {
        url: null as string | null,
        warn: "Para convidar amigos sem login, clique em Publish (canto superior direito) e compartilhe o link público gerado.",
      };
    }
    return { url: `${location.origin}/?join=${code}`, warn: null as string | null };
  };

  const handleShare = async () => {
    const { url, warn } = buildShareUrl();
    setShareWarn(warn);
    if (!url) return;
    try {
      if (navigator.share) await navigator.share({ title: "Verbete", text: `Bora jogar Verbete? Sala ${code} 👇`, url });
      else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    } catch {}
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      className="flex-1 flex flex-col gap-2 min-h-0 overflow-y-auto no-scrollbar pb-2">
      <div className="flex items-center justify-center gap-3">
        <Mascot mood="excited" size={70} />
        <button onClick={handleShare} className="btn-pop bg-gradient-sun text-primary-foreground py-2 px-4 text-sm">
          {copied ? "✅ Copiado!" : "📲 Compartilhar"}
        </button>
      </div>
      {shareWarn && (
        <p className="text-[11px] text-pink text-center font-display leading-tight">{shareWarn}</p>
      )}

      <div className="rounded-2xl bg-card/60 p-2 border border-white/10 shadow-soft flex flex-col shrink-0">
        <h3 className="font-display text-[11px] uppercase text-muted-foreground tracking-wider mb-1.5 px-1">
          Jogadores ({players.length}/12)
        </h3>
        <div className="grid grid-cols-4 gap-x-2 gap-y-3 content-start pt-1.5 px-1.5">
          {[...players].sort((a, b) => {
            const aHost = a.id === hostId ? 0 : 1;
            const bHost = b.id === hostId ? 0 : 1;
            if (aHost !== bHost) return aHost - bHost;
            return (a.joined_at ?? "").localeCompare(b.joined_at ?? "");
          }).map((p) => {
            const team = mode === "teams" ? teams.find((t) => t.id === p.team_id) : undefined;
            return (
              <div key={p.id} className="relative w-[52px] mx-auto">
                <AvatarBubble emoji={p.avatar} color={p.color} size={52}
                  label={(p.is_bot ? "🤖 " : "") + p.nickname} isYou={p.id === playerId} />
                {isHost && p.id !== playerId && (
                  <button onClick={() => kickPlayer(roomId, playerId, p.id)}
                    aria-label={`Remover ${p.nickname} da sala`}
                    className="absolute top-0 right-1 w-4 h-4 bg-destructive rounded-full text-[9px] font-bold leading-none flex items-center justify-center"><span aria-hidden="true">×</span></button>
                )}
                {mode === "teams" && (
                  <div className="mt-1 text-[9px] leading-none text-center font-display truncate"
                    style={{ color: team?.color ?? "rgba(255,255,255,0.4)" }}>
                    {team ? `${team.emoji} ${team.name}` : "— sem time"}
                  </div>
                )}
              </div>
            );
          })}
          {Array.from({ length: slotsLeft }).map((_, i) => (
            <div key={"e" + i} className="flex items-center justify-center w-[52px] h-[52px] mx-auto rounded-full border-2 border-dashed border-white/15 text-white/30 text-base">?</div>
          ))}
        </div>
      </div>

      {players.length < 12 && (
        <div className="rounded-2xl bg-pink/10 border border-pink/30 p-2.5 text-center space-y-1.5">
          <p className="text-[11px] font-display text-pink leading-tight">
            {players.length < 4
              ? `Adicione +${4 - players.length} ${4 - players.length === 1 ? "jogador ou bot" : "jogadores ou bots"} para começar`
              : `Quer mais caos? Adicione bots (até 12)`}
          </p>
          <div className="flex justify-center gap-1.5 flex-wrap">
            <button
              onClick={() => addBot(roomId, players.length)}
              disabled={players.length >= 12}
              className="btn-pop bg-mint text-accent-foreground py-1.5 px-3 text-xs flex items-center gap-1 disabled:opacity-50">
              <span className="text-sm leading-none">🤖</span> +1 Bot
            </button>
            {botsNeeded > 1 && (
              <button
                onClick={() => {
                  for (let i = 0; i < botsNeeded; i++) {
                    addBot(roomId, players.length + i);
                  }
                }}
                className="btn-pop bg-mint/80 text-accent-foreground py-1.5 px-3 text-xs">
                Encher até 4 (+{botsNeeded} 🤖)
              </button>
            )}
          </div>
          {humans === 1 && players.length < 4 && (
            <p className="text-[10px] text-muted-foreground leading-tight">
              Dica: compartilhe a sala com amigos no botão acima 👆
            </p>
          )}
        </div>
      )}

      {isHost && (
        <div className="rounded-2xl bg-card/60 p-3 border border-white/10 shadow-soft space-y-2">
          <ModeAndTeamsConfig roomId={roomId} actorId={playerId} mode={mode} teams={teams} players={players} />

          <div className="space-y-1.5">
            <p className="font-display text-[11px] uppercase text-muted-foreground tracking-wider text-center">
              Como termina a partida?
            </p>
            <div className="flex gap-1.5">
              <button onClick={() => setWinCondition(roomId, playerId, "rounds", winCondition === "rounds" ? winTarget : 10)}
                className={"flex-1 py-2 rounded-lg text-[11px] font-display border leading-tight " + (winCondition === "rounds" ? "bg-pink text-primary-foreground border-pink" : "bg-input border-white/10")}>
                <div>{winCondition === "rounds" ? `${winTarget} rodadas` : "Rodadas"}</div>
                <div className="text-[9px] opacity-80 normal-case">número fixo</div>
              </button>
              <button onClick={() => setWinCondition(roomId, playerId, "score", winCondition === "score" ? winTarget : 15)}
                className={"flex-1 py-2 rounded-lg text-[11px] font-display border leading-tight " + (winCondition === "score" ? "bg-pink text-primary-foreground border-pink" : "bg-input border-white/10")}>
                <div>{winCondition === "score" ? `${winTarget} pts` : "Pontuação"}</div>
                <div className="text-[9px] opacity-80 normal-case">quem chegar 1º</div>
              </button>
            </div>

            {winCondition === "rounds" && (
              <div className="flex gap-1.5 pt-0.5">
                {[5, 10, 15, 20].map((n) => (
                  <button key={n} onClick={() => setWinCondition(roomId, playerId, "rounds", n)}
                    className={"flex-1 py-1 rounded-md text-[10px] font-display border " + (winTarget === n ? "bg-primary text-primary-foreground border-primary" : "bg-input border-white/10")}>
                    {n} rod.
                  </button>
                ))}
              </div>
            )}

            {winCondition === "score" && (
              <div className="flex gap-1.5 pt-0.5">
                {[15, 20, 30, 50].map((n) => (
                  <button key={n} onClick={() => setWinCondition(roomId, playerId, "score", n)}
                    className={"flex-1 py-1 rounded-md text-[10px] font-display border " + (winTarget === n ? "bg-primary text-primary-foreground border-primary" : "bg-input border-white/10")}>
                    {n} pts
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="font-display text-[11px] uppercase text-muted-foreground tracking-wider text-center">
              Nível das palavras
            </p>
            <div className="flex gap-1">
              {NIVEL_META.map((n) => (
                <button key={n.value} onClick={() => { void playUITap(); setNivel(roomId, playerId, n.value); }}
                  className={"flex-1 py-1.5 rounded-lg text-[10px] font-display border leading-tight " + (nivel === n.value ? "bg-pink text-primary-foreground border-pink" : "bg-input border-white/10")}>
                  <div>{n.emoji}</div>
                  <div>{n.label}</div>
                </button>
              ))}
            </div>
          </div>

          <CategoriesPicker roomId={roomId} actorId={playerId} selected={categories} />

          <CustomWordsPicker roomId={roomId} playerId={playerId} />
        </div>
      )}

      {!isHost && categories.length > 0 && (
        <div className="rounded-2xl bg-card/40 p-2 border border-white/10 text-center">
          <p className="text-[10px] font-display uppercase text-muted-foreground tracking-wider">Categorias</p>
          <p className="text-[11px] text-foreground/80 mt-0.5">
            {categories.map((c) => CATEGORY_META[c]?.emoji ?? "🏷️").join(" ")}{" "}
            <span className="text-muted-foreground">({categories.length})</span>
          </p>
        </div>
      )}
      {isHost ? (
        <StartButton
          canStart={canStart}
          playersCount={players.length}
          roomId={roomId}
          players={players}
          mode={mode}
          teams={teams}
        />
      ) : (
        <div className="text-center text-muted-foreground font-display py-2 text-sm">
          {mode === "teams" && (() => {
            const myTeam = teams.find((t) => t.id === players.find((p) => p.id === playerId)?.team_id);
            return myTeam ? (
              <p className="mb-1 font-display" style={{ color: myTeam.color }}>
                {myTeam.emoji} Você está no time {myTeam.name}
              </p>
            ) : (
              <p className="mb-1 text-pink">⏳ Aguardando o host te colocar num time…</p>
            );
          })()}
          Aguardando o host iniciar…
        </div>
      )}
    </motion.div>
  );
}

function CategoriesPicker({ roomId, actorId, selected }: { roomId: string; actorId: string; selected: string[] }) {
  const toggle = (cat: string) => {
    const next = selected.includes(cat) ? selected.filter((c) => c !== cat) : [...selected, cat];
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
        <p className="font-display text-[11px] uppercase text-muted-foreground tracking-wider">
          Categorias {selected.length > 0 && <span className="text-foreground/70">({selected.length})</span>}
        </p>
        <button onClick={clear}
          className="text-[10px] font-display uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-40"
          disabled={selected.length === 0}>
          Todas
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {entries.map(([cat, meta]) => {
          const on = selected.includes(cat);
          return (
            <button key={cat} onClick={() => toggle(cat)}
              className={"py-1.5 rounded-lg text-[10px] font-display border leading-tight flex flex-col items-center gap-0.5 " +
                (on ? "bg-pink text-primary-foreground border-pink" : "bg-input border-white/10 text-foreground/80")}>
              <span className="text-sm leading-none">{meta.emoji}</span>
              <span className="truncate w-full text-center">{meta.label}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[9px] text-muted-foreground text-center font-display">
        {selected.length === 0 ? "Sem filtro: todas as palavras entram no sorteio." : "Apenas palavras das categorias marcadas serão sorteadas."}
      </p>
    </div>
  );
}

function ModeAndTeamsConfig({
  roomId, actorId, mode, teams, players,
}: { roomId: string; actorId: string; mode: RoomMode; teams: Team[]; players: Player[]; }) {
  const switchMode = (next: RoomMode) => {
    if (next === mode) return;
    const initial = next === "teams" && teams.length === 0 ? TEAM_PRESETS["men-women"] : teams;
    void setRoomMode(roomId, actorId, next, initial);
  };
  const applyPreset = (key: keyof typeof TEAM_PRESETS) => {
    void setRoomTeams(roomId, actorId, TEAM_PRESETS[key]);
    players.forEach((p) => assignPlayerToTeam(roomId, actorId, p.id, null));
  };
  return (
    <div className="space-y-1.5">
      <p className="font-display text-[11px] uppercase text-muted-foreground tracking-wider text-center">
        Modo de jogo
      </p>
      <div className="flex gap-1.5">
        <button onClick={() => switchMode("individual")}
          className={"flex-1 py-2 rounded-lg text-[11px] font-display border leading-tight " + (mode === "individual" ? "bg-sun text-primary-foreground border-sun" : "bg-input border-white/10")}>
          🙋 Individual
        </button>
        <button onClick={() => switchMode("teams")}
          className={"flex-1 py-2 rounded-lg text-[11px] font-display border leading-tight " + (mode === "teams" ? "bg-sun text-primary-foreground border-sun" : "bg-input border-white/10")}>
          👥 Equipes
        </button>
      </div>
      {mode === "teams" && (() => {
        const activePreset: keyof typeof TEAM_PRESETS | null =
          teams.length === 2 && teams[0]?.id === "men" ? "men-women" :
          teams.length === 2 && teams[0]?.id === "a" ? "ab" :
          teams.length === 3 ? "abc" : null;
        const presetBtn = (key: keyof typeof TEAM_PRESETS, label: string) => (
          <button onClick={() => applyPreset(key)}
            className={"flex-1 py-1 rounded-md text-[10px] font-display border leading-tight " + (activePreset === key ? "bg-sun text-primary-foreground border-sun" : "bg-input border-white/10")}>
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
          <button onClick={() => autoBalanceTeams(roomId, actorId, players, teams)}
            className="w-full py-1.5 rounded-md text-[11px] font-display border bg-mint/15 border-mint/40 text-mint">
            ⚖️ Distribuir automaticamente
          </button>
          <div className="space-y-1 pt-1">
            <p className="font-display text-[10px] uppercase text-muted-foreground tracking-wider">Toque num jogador para mudar de time:</p>
            {players.map((p) => {
              const currentTeam = teams.find((t) => t.id === p.team_id);
              const nextTeam = (() => {
                const idx = teams.findIndex((t) => t.id === p.team_id);
                return teams[(idx + 1) % teams.length];
              })();
              return (
                <button
                  key={p.id}
                  onClick={() => assignPlayerToTeam(roomId, actorId, p.id, nextTeam?.id ?? null)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-input border border-white/10 text-[11px]"
                >
                  <span className="text-base">{p.avatar}</span>
                  <span className="font-display flex-1 text-left truncate">{p.nickname}{p.is_bot ? " 🤖" : ""}</span>
                  {currentTeam ? (
                    <span className="font-display px-2 py-0.5 rounded-full"
                      style={{ background: currentTeam.color + "33", color: currentTeam.color, border: "1px solid " + currentTeam.color + "66" }}>
                      {currentTeam.emoji} {currentTeam.name}
                    </span>
                  ) : (
                    <span className="font-display px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-muted-foreground">— sem time</span>
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

function StartButton({ canStart, playersCount, roomId, players, mode, teams }: {
  canStart: boolean; playersCount: number; roomId: string; players: Player[]; mode: RoomMode; teams: Team[];
}) {
  const [starting, setStarting] = useState(false);
  const teamsOK = mode !== "teams" || (teams.length >= 2 && players.every((p) => !!p.team_id));
  const allOK = canStart && teamsOK;
  const onClick = async () => {
    if (starting || !allOK) return;
    void playUITap("primary");
    setStarting(true);
    try {
      await startGame({ id: roomId, current_coordinator: null } as Room, players);
    } catch (e) {
      console.error(e);
      setStarting(false);
    }
  };
  const label = starting
    ? "Iniciando…"
    : !canStart
        ? `Mín. 2 jogadores (${playersCount}/2)`
        : !teamsOK
          ? "⚠️ Atribua todos a um time"
          : "🚀 Começar!";
  return (
    <button
      disabled={!allOK || starting}
      onClick={onClick}
      className="btn-pop bg-gradient-fun text-white text-lg py-3 disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function CustomWordsPicker({ roomId, playerId }: { roomId: string; playerId: string }) {
  const [list, setList] = useState<RoomWord[]>([]);
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState("");
  const [meaning, setMeaning] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchRoomWords(roomId).then((rs) => { if (alive) setList(rs); });
    return () => { alive = false; };
  }, [roomId]);

  const add = async () => {
    if (busy || !word.trim() || !meaning.trim()) return;
    setBusy(true);
    try {
      const created = await addRoomWord(roomId, playerId, word, meaning);
      if (created) {
        setList((cur) => [created, ...cur]);
        setWord(""); setMeaning("");
      }
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setList((cur) => cur.filter((w) => w.id !== id));
    await deleteRoomWord(id);
  };

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-1 py-0.5"
      >
        <span className="font-display text-[11px] uppercase text-muted-foreground tracking-wider">
          ✍️ Palavras próprias {list.length > 0 && <span className="text-foreground/70">({list.length})</span>}
        </span>
        <span className="text-muted-foreground text-[11px]">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="space-y-1.5 pt-1">
          <div className="flex gap-1.5">
            <input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              maxLength={40}
              placeholder="palavra"
              className="flex-1 min-w-0 px-2 py-1.5 rounded-md bg-input border border-white/10 text-[12px] font-display"
            />
            <input
              value={meaning}
              onChange={(e) => setMeaning(e.target.value)}
              maxLength={220}
              placeholder="significado real"
              className="flex-[1.6] min-w-0 px-2 py-1.5 rounded-md bg-input border border-white/10 text-[12px]"
            />
            <button
              onClick={add}
              disabled={busy || !word.trim() || !meaning.trim()}
              className="btn-pop bg-mint text-accent-foreground px-2.5 text-[11px] disabled:opacity-40"
            >
              +
            </button>
          </div>

          {list.length > 0 && (
            <div className="max-h-32 overflow-y-auto no-scrollbar space-y-1">
              {list.map((w) => (
                <div key={w.id} className="flex items-start gap-2 px-2 py-1 rounded-md bg-input/60 border border-white/5 text-[11px]">
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-foreground truncate">{w.word}</div>
                    <div className="text-muted-foreground line-clamp-2">{w.meaning}</div>
                  </div>
                  <button
                    onClick={() => remove(w.id)}
                    aria-label={`Remover ${w.word}`}
                    className="w-5 h-5 rounded-full bg-destructive/80 text-[10px] font-bold leading-none flex items-center justify-center shrink-0"
                  >×</button>
                </div>
              ))}
            </div>
          )}

          <p className="text-[9px] text-muted-foreground text-center font-display leading-tight">
            Suas palavras entram no sorteio junto com as do dicionário oficial.
          </p>
        </div>
      )}
    </div>
  );
}

export default Lobby;


