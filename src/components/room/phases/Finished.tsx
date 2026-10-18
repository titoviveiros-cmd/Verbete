import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import {
  restartGame,
  computeTeamScores,
  isTruthDef,
  type Definition,
  type Player,
  type Room,
  type Vote,
} from "@/lib/room";
import { Mascot } from "@/components/Mascot";
import { Confetti } from "@/components/Confetti";
import { Scoreboard } from "@/components/room/phases/Scoreboard";
import { useAuth } from "@/hooks/use-auth";
import { pushAchievement } from "@/components/AchievementToaster";
import { hapticBigWin, hapticSuccess } from "@/lib/sound";
import { scrollbarClip } from "@/lib/utils";
import { shareInvite } from "@/lib/share";
import { APP_URL } from "@/lib/app-url";

export function Finished({
  room,
  players,
  isHost,
  roomId,
  roomCode,
  playerId,
  onLeave,
}: {
  room: Room;
  players: Player[];
  isHost: boolean;
  roomId: string;
  roomCode: string;
  playerId: string;
  onLeave: () => void;
}) {
  const sortedTeams =
    room.mode === "teams" && (room.teams?.length ?? 0) > 0
      ? computeTeamScores(players, room.teams ?? []).sort(
          (a, b) => b.score - a.score,
        )
      : [];
  const teamWinner = sortedTeams[0];
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const { user, loading: authLoading } = useAuth();
  const isGuest = !authLoading && !user;
  const myFinalScore = sorted.find((p) => p.id === playerId)?.score ?? 0;

  // Histórico da partida (defs + votos) — alimenta o registro de XP e as
  // estatísticas divertidas do pódio.
  const [history, setHistory] = useState<{
    defs: Definition[];
    votes: Vote[];
  } | null>(null);
  useEffect(() => {
    (async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const [{ data: defs }, { data: votes }] = await Promise.all([
        // S1: leitura direta de definitions foi revogada — RPC status-gated.
        supabase.rpc("get_room_definitions", { p_room_id: roomId }),
        supabase.from("votes").select("*").eq("room_id", roomId),
      ]);
      setHistory({
        defs: (defs ?? []) as unknown as Definition[],
        votes: (votes ?? []) as Vote[],
      });
    })().catch((e) => console.error("finished history fetch failed", e));
  }, [roomId]);

  const [xpResult, setXpResult] = useState<{
    xpGained: number;
    level: number;
  } | null>(null);
  const recordedRef = useRef(false);
  useEffect(() => {
    if (recordedRef.current || !history) return;
    recordedRef.current = true;
    (async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      // Fase 1 (S3): o servidor calcula TUDO (score, posição, acertos,
      // blefes, XP, conquistas) a partir das tabelas oficiais. O client
      // apenas vincula sua identidade ao jogador e informa a sala.
      await supabase.rpc("claim_player_identity", {
        p_player_id: playerId,
      });
      const { data } = await supabase.rpc("record_match_result", {
        p_room_code: roomCode,
      });
      const res = data as {
        xp_gained?: number;
        level?: number;
        unlocked?: string[];
        deduped?: boolean;
      } | null;
      if (res && !res.deduped && (res.xp_gained ?? 0) > 0) {
        setXpResult({ xpGained: res.xp_gained ?? 0, level: res.level ?? 1 });
      }
      const codes = res?.unlocked ?? [];
      if (codes.length > 0) {
        const { fetchAllAchievements } = await import("@/lib/daily");
        const catalog = await fetchAllAchievements();
        for (const code of codes) {
          const a = catalog.find((c) => c.code === code);
          if (a) pushAchievement(a);
        }
      }
    })().catch((e) => console.error("record_match_result failed", e));
  }, [history]);
  const winner = sorted[0];
  const second = sorted[1];
  const third = sorted[Math.min(2, sorted.length - 1)];

  // Fase 5: haptic cerimonial no pódio — campeão sente a vitória grande.
  const hapticPlayed = useRef(false);
  useEffect(() => {
    if (hapticPlayed.current) return;
    hapticPlayed.current = true;
    const t = setTimeout(() => {
      if (winner?.id === playerId) hapticBigWin();
      else hapticSuccess();
    }, 900); // junto com o quique dos avatares no pódio
    return () => clearTimeout(t);
  }, []);

  const titles: Array<{
    title: string;
    desc: string;
    player?: Player;
    medal: string;
    tone: string;
  }> = [
    {
      title: "Campeão",
      desc: "Fez mais pontos somando acertos e blefes que enganaram a galera.",
      player: winner,
      medal: "🥇",
      tone: "#FFD166", // ouro
    },
    {
      title: "Mentiroso Profissional",
      desc: "Quase no topo — convenceu muita gente com significados inventados.",
      player: second ?? winner,
      medal: "🥈",
      tone: "#C0C0C0", // prata
    },
    {
      title: "Enciclopédia Humana",
      desc: "Soube reconhecer (ou chutar bem) os significados verdadeiros.",
      player: third,
      medal: "🥉",
      tone: "#CD7F32", // bronze
    },
  ];

  // Compartilhar o resultado (pódio digno de print): texto do campeão +
  // link público do jogo — o mesmo helper do convite do Lobby.
  const [shareNote, setShareNote] = useState<string | null>(null);
  const handleShareResult = async () => {
    const champion = teamWinner
      ? teamWinner.name
      : (winner?.nickname ?? "Alguém");
    const pts = teamWinner ? teamWinner.score : (winner?.score ?? 0);
    const outcome = await shareInvite({
      title: "Verbete",
      text: `🏆 ${champion} venceu no Verbete com ${pts} pts! Bora jogar? Blefe, vote e descubra palavras raras 👇`,
      url: `${APP_URL}/`,
    });
    if (outcome === "copied") setShareNote("Link copiado! ✅");
    else if (outcome === "failed")
      setShareNote(`Não deu para abrir o compartilhamento. Link: ${APP_URL}/`);
    else setShareNote(null);
    if (outcome === "copied") setTimeout(() => setShareNote(null), 2500);
  };

  const [viewingScoreboard, setViewingScoreboard] = useState(false);
  if (viewingScoreboard) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="flex-1 flex flex-col min-h-0 pt-2"
      >
        <div
          className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col gap-2"
          style={scrollbarClip()}
        >
          <button
            type="button"
            onClick={() => setViewingScoreboard(false)}
            className="glass-tile self-start flex items-center gap-1.5 text-sm font-display px-3 py-1.5 rounded-full transition"
          >
            ← Voltar ao resumo
          </button>
          <Scoreboard room={room} players={players} isHost={false} />
        </div>
      </motion.div>
    );
  }

  // Pódio: degraus "candy" (ouro / prata / bronze) com aresta, como os
  // botões da coleção — a peça de vitória do Verbete.
  const PODIUM = [
    {
      p: sorted[1],
      place: 2,
      h: 70,
      medal: "🥈",
      tone: "#C0C0C0",
      block: "podium-silver",
    },
    {
      p: sorted[0],
      place: 1,
      h: 104,
      medal: "👑",
      tone: "#f4c542",
      block: "podium-gold",
    },
    {
      p: sorted[2],
      place: 3,
      h: 52,
      medal: "🥉",
      tone: "#CD7F32",
      block: "podium-bronze",
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex-1 flex flex-col min-h-0 pt-2"
    >
      <Confetti />
      <div
        className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col gap-3 pb-2 lg:grid lg:grid-cols-[1.1fr_0.9fr] lg:grid-rows-[auto_1fr] lg:gap-x-8 lg:gap-y-3 lg:content-start"
        style={scrollbarClip()}
      >
        {/* Coluna heroica: vencedor + pódio. No desktop a pontuação final
            sobe para o topo da coluna direita (o pódio cabe sem rolar). */}
        <div className="flex flex-col gap-3 min-w-0 lg:col-start-1 lg:row-start-1 lg:row-span-2 lg:justify-center">
          <motion.div
            initial={{ scale: 0.85, opacity: 0, y: -8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 220, damping: 16 }}
            className="relative flex flex-col items-center text-center pt-1"
          >
            <div
              aria-hidden
              className="absolute top-2 left-1/2 -translate-x-1/2 w-72 h-40 rounded-full pointer-events-none"
              style={{
                background:
                  "radial-gradient(closest-side, rgb(244 197 66 / 0.35), transparent 75%)",
                filter: "blur(10px)",
              }}
            />
            <Mascot mood="excited" size={64} className="relative -mb-1" />
            <p className="eyebrow relative">
              Fim de jogo · {room.current_round}{" "}
              {room.current_round === 1 ? "rodada" : "rodadas"}
            </p>
            {teamWinner ? (
              <h2 className="relative font-display text-[34px] lg:text-[44px] leading-tight mt-1">
                <span className="mr-1">{teamWinner.emoji}</span>
                <span className="text-gold-grad">
                  {teamWinner.name} venceu!
                </span>
              </h2>
            ) : (
              <h2 className="relative font-display text-[34px] lg:text-[46px] leading-tight mt-1 text-gold-grad">
                {winner?.nickname} venceu!
              </h2>
            )}
            <p className="relative text-sm text-muted-foreground">
              {teamWinner
                ? `${teamWinner.score} pts somando a equipe`
                : `${winner?.score ?? 0} pts · Campeão da sala ${roomCode}`}
            </p>
            <button
              type="button"
              onClick={handleShareResult}
              className="btn-pop btn-violet relative text-sm px-4 py-2 mt-2.5"
            >
              📲 Compartilhar resultado
            </button>
            {shareNote && (
              <p
                role="status"
                className="relative text-[12px] text-mint font-bold mt-1.5"
              >
                {shareNote}
              </p>
            )}
          </motion.div>

          {/* Fase 4 (aprovado 2026-07-20): PÓDIO com degraus — avatares sobem
              com quique, campeão maior no centro. */}
          <div className="flex items-end justify-center gap-2.5 px-4 mt-1">
            {PODIUM.filter((x) => !!x.p).map(
              ({ p, place, h, medal, tone, block }) => (
                <div
                  key={place}
                  className="flex flex-col items-center flex-1 max-w-[132px] lg:max-w-[160px] min-w-0"
                >
                  <motion.div
                    initial={{ y: 46, opacity: 0, scale: 0.5 }}
                    animate={{
                      y: 0,
                      opacity: 1,
                      scale: place === 1 ? 1.12 : 1,
                    }}
                    transition={{
                      delay: place === 1 ? 0.85 : place === 2 ? 0.45 : 0.25,
                      type: "spring",
                      stiffness: 230,
                      damping: 13,
                    }}
                    className="flex flex-col items-center min-w-0 w-full"
                  >
                    <motion.span
                      className="text-2xl leading-none mb-1"
                      animate={
                        place === 1
                          ? { rotate: [-8, 8, -8], y: [0, -2, 0] }
                          : {}
                      }
                      transition={{ duration: 2, repeat: Infinity }}
                      aria-hidden
                    >
                      {medal}
                    </motion.span>
                    <span
                      className="w-14 h-14 lg:w-16 lg:h-16 rounded-full flex items-center justify-center text-3xl lg:text-4xl"
                      style={{
                        background: `radial-gradient(circle at 30% 25%, ${p!.color}cc, ${p!.color})`,
                        boxShadow: `0 0 0 3px ${tone}, 0 0 22px -2px ${tone}aa, 0 4px 0 rgb(0 0 0 / 0.35)`,
                      }}
                    >
                      {p!.avatar}
                    </span>
                    <span
                      className="font-display text-sm lg:text-base mt-1.5 w-full text-center truncate"
                      style={{ color: tone }}
                    >
                      {p!.nickname}
                    </span>
                    <span className="font-display text-xl tabular-nums leading-none">
                      {p!.score}
                      <span className="text-xs text-muted-foreground">
                        {" "}
                        pts
                      </span>
                    </span>
                  </motion.div>
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: h, opacity: 1 }}
                    transition={{
                      delay: place === 1 ? 0.55 : place === 2 ? 0.2 : 0.05,
                      type: "spring",
                      stiffness: 210,
                      damping: 19,
                    }}
                    className={
                      "podium-block w-full mt-2 flex items-start justify-center pt-1.5 " +
                      block
                    }
                  >
                    <span className="font-display text-xl">{place}º</span>
                  </motion.div>
                </div>
              ),
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 min-w-0 lg:col-start-2 lg:row-start-1">
          {sortedTeams.length > 0 && (
            <div className="sticker !py-2.5">
              <p className="eyebrow text-center mb-1.5">Ranking por equipe</p>
              <ul className="space-y-1">
                {sortedTeams.map((t, i) => (
                  <li key={t.id} className="flex items-center gap-2 px-2">
                    <span className="font-display text-sm w-5 text-center text-sun">
                      {i + 1}
                    </span>
                    <span className="text-base">{t.emoji}</span>
                    <span
                      className="font-display text-sm flex-1 truncate"
                      style={{ color: t.color }}
                    >
                      {t.name}
                    </span>
                    <span
                      className="font-display text-base tabular-nums"
                      style={{ color: t.color }}
                    >
                      {t.score}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sortedTeams.length === 0 && (
            <div className="sticker !py-2.5">
              <p className="eyebrow text-center mb-1.5">Pontuação final</p>
              <ul className="space-y-1">
                {sorted.map((p, i) => (
                  <li
                    key={p.id}
                    className={
                      "flex items-center gap-2 px-2 py-0.5 rounded-lg " +
                      (p.id === playerId ? "bg-pink/10" : "")
                    }
                  >
                    <span className="font-display text-xs w-6 text-center text-muted-foreground tabular-nums">
                      {i + 1}º
                    </span>
                    <span className="text-base">{p.avatar}</span>
                    <span className="font-display text-sm flex-1 truncate">
                      {p.nickname}
                      {p.id === playerId ? " (você)" : ""}
                    </span>
                    <span className="font-display text-sm text-sun tabular-nums">
                      {p.score} pts
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Coluna dos títulos, XP e destaques */}
        <div className="flex flex-col gap-2.5 min-w-0 lg:col-start-2 lg:row-start-2">
          <p className="eyebrow text-center lg:text-left">
            🏆 Títulos da partida
          </p>
          {isGuest && (
            <motion.div
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.4 }}
              className="panel !rounded-2xl border-pink/40 p-3 flex items-center gap-3"
            >
              <div className="text-2xl shrink-0" aria-hidden>
                🏅
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display text-sm leading-tight">
                  Crie uma conta para entrar no ranking!
                </p>
                <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                  Você fez{" "}
                  <span className="font-display text-pink">
                    {myFinalScore} pts
                  </span>
                  , mas como convidado eles não contam no ranking global.
                  Próximas partidas vão acumular.
                </p>
              </div>
              <Link
                to="/login"
                className="btn-pop btn-gold text-xs px-3 py-2 font-display shrink-0"
              >
                Criar conta
              </Link>
            </motion.div>
          )}
          {titles.map(({ title, desc, player, medal, tone }, idx) => {
            if (!player) return null;
            const team =
              sortedTeams.length > 0
                ? (room.teams ?? []).find((t) => t.id === player.team_id)
                : undefined;
            const isGold = idx === 0;
            return (
              <motion.div
                key={title}
                initial={{ y: 20, opacity: 0, scale: isGold ? 0.9 : 1 }}
                animate={{ y: 0, opacity: 1, scale: 1 }}
                transition={{
                  delay: 0.2 + idx * 0.15,
                  type: "spring",
                  stiffness: 200,
                }}
                className={
                  "sticker !rounded-2xl flex flex-col gap-0.5 " +
                  (isGold ? "!py-3 !px-3.5 ring-gold" : "!py-2 !px-3")
                }
                style={
                  isGold
                    ? undefined
                    : {
                        borderColor: `${tone}88`,
                        boxShadow: `0 0 12px -4px ${tone}66, var(--shadow-piece)`,
                      }
                }
              >
                <div className="flex items-center gap-2.5">
                  <motion.span
                    animate={
                      isGold
                        ? { rotate: [0, -8, 8, -4, 4, 0], scale: [1, 1.15, 1] }
                        : undefined
                    }
                    transition={
                      isGold
                        ? { duration: 1.2, repeat: Infinity, repeatDelay: 2 }
                        : undefined
                    }
                    className={
                      "shrink-0 leading-none " +
                      (isGold ? "text-4xl" : "text-2xl")
                    }
                    style={{ filter: `drop-shadow(0 0 8px ${tone})` }}
                  >
                    {medal}
                  </motion.span>
                  <div className="flex-1 min-w-0">
                    <span
                      className={
                        "font-display block leading-tight " +
                        (isGold ? "text-base" : "text-sm")
                      }
                      style={{ color: tone }}
                    >
                      {title}
                    </span>
                    <p className="text-[11px] text-muted-foreground leading-tight">
                      {desc}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <div className="flex items-center gap-1">
                      <span className={isGold ? "text-xl" : "text-base"}>
                        {player.avatar}
                      </span>
                      <span
                        className={
                          "font-display " + (isGold ? "text-sm" : "text-xs")
                        }
                      >
                        {player.nickname}
                      </span>
                    </div>
                    <span
                      className="font-display text-[11px] tabular-nums"
                      style={{ color: tone }}
                    >
                      {player.score} pts
                    </span>
                    {sortedTeams.length > 0 && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-display border leading-none"
                        style={{
                          color: team?.color ?? "rgba(255,255,255,0.55)",
                          borderColor: team?.color ?? "rgba(255,255,255,0.18)",
                          backgroundColor: team
                            ? `${team.color}1a`
                            : "rgba(255,255,255,0.06)",
                        }}
                      >
                        <span>{team?.emoji ?? "—"}</span>
                        <span className="truncate max-w-[80px]">
                          {team?.name ?? "sem time"}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}

          {xpResult && (
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 240 }}
              className="btn-gold rounded-2xl text-center py-2.5 border-2 shadow-[0_4px_0_0_var(--c-gold-edge)]"
            >
              <span className="font-display text-xl">
                ⚡ +{xpResult.xpGained} XP
              </span>
              <span className="font-display text-sm ml-2 opacity-80">
                Nível {xpResult.level}
              </span>
            </motion.div>
          )}

          <FunStats players={players} history={history} />
        </div>
      </div>

      <div className="flex gap-2.5 mt-2 pt-2.5 border-t border-[var(--c-line)] bg-background/80 backdrop-blur-sm sticky bottom-0 lg:justify-center">
        <button
          onClick={onLeave}
          className="btn-pop btn-plain flex-1 lg:flex-none lg:min-w-[150px] text-sm sm:text-base !px-3 py-3 whitespace-nowrap"
        >
          Sair
        </button>
        <button
          onClick={() => setViewingScoreboard(true)}
          className="btn-pop btn-plain flex-1 lg:flex-none lg:min-w-[170px] text-sm sm:text-base !px-3 py-3 whitespace-nowrap"
          title="Rever placar da última rodada"
        >
          📊 Placar
        </button>
        {isHost && (
          <button
            onClick={() => restartGame(roomId)}
            className="btn-pop btn-gold flex-[1.7] lg:flex-none lg:min-w-[260px] text-base sm:text-lg !px-3 py-3 whitespace-nowrap"
          >
            🔄 Nova partida
          </button>
        )}
      </div>
    </motion.div>
  );
}

// Estatísticas divertidas do fim de partida (spec): maior enganador,
// maior enganado, resposta mais votada e maior sequência de acertos.
function FunStats({
  players,
  history,
}: {
  players: Player[];
  history: { defs: Definition[]; votes: Vote[] } | null;
}) {
  const stats = useMemo(() => {
    if (!history || history.votes.length === 0) return [];
    const byId = new Map(players.map((p) => [p.id, p]));
    const truthIds = new Set(history.defs.filter(isTruthDef).map((d) => d.id));
    const defById = new Map(history.defs.map((d) => [d.id, d]));

    // Maior enganador: mais votos recebidos nas próprias definições falsas
    const fooledBy = new Map<string, number>();
    // Maior enganado: mais votos dados em definições falsas
    const fooledCount = new Map<string, number>();
    // Resposta mais votada (qualquer definição)
    const votesByDef = new Map<string, number>();
    // Sequência de acertos por jogador (rodadas consecutivas votando na verdade)
    const votesByPlayerRound = new Map<string, Map<number, boolean>>();

    for (const v of history.votes) {
      votesByDef.set(
        v.definition_id,
        (votesByDef.get(v.definition_id) ?? 0) + 1,
      );
      const def = defById.get(v.definition_id);
      if (!def) continue;
      if (truthIds.has(def.id)) {
        let m = votesByPlayerRound.get(v.voter_id);
        if (!m) {
          m = new Map();
          votesByPlayerRound.set(v.voter_id, m);
        }
        m.set(v.round, true);
      } else {
        fooledCount.set(v.voter_id, (fooledCount.get(v.voter_id) ?? 0) + 1);
        if (def.player_id !== v.voter_id) {
          fooledBy.set(def.player_id, (fooledBy.get(def.player_id) ?? 0) + 1);
        }
        let m = votesByPlayerRound.get(v.voter_id);
        if (!m) {
          m = new Map();
          votesByPlayerRound.set(v.voter_id, m);
        }
        m.set(v.round, false);
      }
    }

    const top = (m: Map<string, number>) => {
      let best: { id: string; n: number } | null = null;
      for (const [id, n] of m) if (!best || n > best.n) best = { id, n };
      return best && best.n > 0 ? best : null;
    };

    // Maior sequência de acertos consecutivos entre todos os jogadores
    let bestStreak: { id: string; n: number } | null = null;
    const rounds = Array.from(new Set(history.defs.map((d) => d.round))).sort(
      (a, b) => a - b,
    );
    for (const [pid, m] of votesByPlayerRound) {
      let cur = 0,
        max = 0;
      for (const r of rounds) {
        if (m.get(r) === true) {
          cur++;
          max = Math.max(max, cur);
        } else if (m.has(r)) cur = 0;
      }
      if (max >= 2 && (!bestStreak || max > bestStreak.n))
        bestStreak = { id: pid, n: max };
    }

    let topVotedDef: { def: Definition; n: number } | null = null;
    for (const [defId, n] of votesByDef) {
      const def = defById.get(defId);
      if (!def || truthIds.has(defId)) continue;
      if (!topVotedDef || n > topVotedDef.n) topVotedDef = { def, n };
    }

    const out: Array<{ emoji: string; label: string; value: string }> = [];
    const enganador = top(fooledBy);
    if (enganador) {
      const p = byId.get(enganador.id);
      if (p)
        out.push({
          emoji: "🦊",
          label: "Maior enganador",
          value: `${p.avatar} ${p.nickname} — enganou ${enganador.n}×`,
        });
    }
    const enganado = top(fooledCount);
    if (enganado) {
      const p = byId.get(enganado.id);
      if (p)
        out.push({
          emoji: "🎣",
          label: "Maior enganado",
          value: `${p.avatar} ${p.nickname} — caiu ${enganado.n}×`,
        });
    }
    if (bestStreak) {
      const p = byId.get(bestStreak.id);
      if (p)
        out.push({
          emoji: "🎯",
          label: "Sequência de acertos",
          value: `${p.avatar} ${p.nickname} — ${bestStreak.n} seguidos`,
        });
    }
    if (topVotedDef && topVotedDef.n >= 2) {
      const author = byId.get(topVotedDef.def.player_id);
      out.push({
        emoji: "🗳️",
        label: "Blefe mais votado",
        value: `"${topVotedDef.def.text.slice(0, 60)}${topVotedDef.def.text.length > 60 ? "…" : ""}"${author ? ` — ${author.nickname}` : ""}`,
      });
    }
    return out;
  }, [players, history]);

  if (stats.length === 0) return null;
  return (
    <div className="sticker !py-2.5 space-y-2">
      <p className="eyebrow text-center">😜 Destaques da partida</p>
      {stats.map((s, i) => (
        <motion.div
          key={s.label}
          initial={{ x: -12, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ delay: 0.5 + i * 0.12 }}
          className="flex items-start gap-2 px-2"
        >
          <span className="text-base shrink-0">{s.emoji}</span>
          <div className="min-w-0">
            <p className="eyebrow !text-[10px] leading-none">{s.label}</p>
            <p className="text-[13px] leading-snug break-words mt-0.5">
              {s.value}
            </p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

export default Finished;
