import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import { restartGame, computeTeamScores, type Player, type Room } from "@/lib/room";
import { Mascot } from "@/components/Mascot";
import { Confetti } from "@/components/Confetti";
import { Scoreboard } from "@/components/room/phases/Scoreboard";
import { useAuth } from "@/hooks/use-auth";

export function Finished({ room, players, isHost, roomId, roomCode, playerId, onLeave }: {
  room: Room; players: Player[]; isHost: boolean; roomId: string; roomCode: string; playerId: string; onLeave: () => void;
}) {
  const sortedTeams = (room.mode === "teams" && (room.teams?.length ?? 0) > 0)
    ? computeTeamScores(players, room.teams ?? []).sort((a, b) => b.score - a.score)
    : [];
  const teamWinner = sortedTeams[0];
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const { user, loading: authLoading } = useAuth();
  const isGuest = !authLoading && !user;
  const myFinalScore = sorted.find((p) => p.id === playerId)?.score ?? 0;
  const recordedRef = useRef(false);
  useEffect(() => {
    if (recordedRef.current) return;
    recordedRef.current = true;
    (async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const me = sorted.find((p) => p.id === playerId);
      if (!me) return;
      const position = sorted.findIndex((p) => p.id === playerId) + 1;
      await (supabase.rpc as any)("record_match_result", {
        p_user_id: user.id,
        p_room_code: roomCode,
        p_final_score: me.score,
        p_position: position,
        p_players_count: sorted.length,
        p_rounds_coordinated: me.coordinator_count ?? 0,
      });
    })().catch((e) => console.error("record_match_result failed", e));
  }, []);
  const winner = sorted[0];
  const second = sorted[1];
  const third = sorted[Math.min(2, sorted.length - 1)];


  const titles: Array<{ title: string; desc: string; player?: Player; medal: string; tone: string }> = [
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

  const [viewingScoreboard, setViewingScoreboard] = useState(false);
  if (viewingScoreboard) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col min-h-0 pt-2">
        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setViewingScoreboard(false)}
            className="self-start flex items-center gap-1.5 text-sm font-display px-3 py-1.5 rounded-full bg-card/60 border border-white/10 hover:bg-card/80 transition">
            ← Voltar ao resumo
          </button>
          <Scoreboard room={room} players={players} isHost={false} />
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col min-h-0 pt-2">

      <Confetti />
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col gap-2 pb-2">
        <div className="flex flex-col items-center">
          <Mascot mood="excited" size={72} />
          <motion.div
            initial={{ scale: 0.85, opacity: 0, y: -8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 220, damping: 16 }}
            className="relative w-full max-w-sm mt-1"
          >
            <div
              className="absolute -inset-3 rounded-[2rem] blur-2xl opacity-60 pointer-events-none"
              style={{ background: "var(--gradient-fun)" }}
              aria-hidden
            />
            <div
              className="relative rounded-[1.5rem] border-2 border-white/25 overflow-hidden px-4 py-3"
              style={{
                background: "var(--gradient-fun)",
                boxShadow: "0 6px 0 0 oklch(0.15 0.05 290 / 0.45), 0 16px 36px -10px oklch(0.72 0.22 0 / 0.55), inset 0 1px 0 0 rgba(255,255,255,0.35)",
              }}
            >
              <motion.span
                className="absolute top-1.5 left-3 text-base"
                animate={{ rotate: [0, 20, -10, 0], scale: [1, 1.2, 1] }}
                transition={{ duration: 2.4, repeat: Infinity }}
                aria-hidden
              >✨</motion.span>
              <motion.span
                className="absolute top-2 right-3 text-sm"
                animate={{ rotate: [0, -15, 15, 0], scale: [1, 1.3, 1] }}
                transition={{ duration: 2.8, repeat: Infinity, delay: 0.4 }}
                aria-hidden
              >⭐</motion.span>

              <div className="flex flex-col items-center text-center gap-1.5">
                <motion.div
                  animate={{ rotate: [-5, 5, -5], y: [0, -2, 0] }}
                  transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                  className="text-3xl leading-none drop-shadow-[0_2px_0_rgba(0,0,0,0.4)]"
                  aria-hidden
                >🏆</motion.div>
                <h2
                  className="font-display text-2xl text-white tracking-tight leading-none"
                  style={{ textShadow: "0 2px 0 oklch(0.15 0.05 290 / 0.6), 0 0 18px oklch(0.88 0.18 95 / 0.55)" }}
                >
                  Fim de jogo!
                </h2>
                {teamWinner ? (
                  <div
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/95 border-2 shadow-sm"
                    style={{ borderColor: teamWinner.color }}
                  >
                    <span className="text-sm leading-none">{teamWinner.emoji}</span>
                    <span className="font-display text-xs leading-none" style={{ color: teamWinner.color }}>
                      {teamWinner.name} venceu · {teamWinner.score} pts
                    </span>
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/95 border-2 border-sun shadow-sm">
                    <span className="text-sm leading-none">{winner?.avatar}</span>
                    <span className="font-display text-xs leading-none" style={{ color: "oklch(0.22 0.06 290)" }}>
                      {winner?.nickname} venceu!
                    </span>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>

        {sortedTeams.length > 0 && (
          <div className="sticker py-1.5">
            <p className="font-display text-[10px] uppercase tracking-widest text-center opacity-80 mb-1">
              Ranking por equipe
            </p>
            <ul className="space-y-0.5">
              {sortedTeams.map((t, i) => (
                <li key={t.id} className="flex items-center gap-2 px-2">
                  <span className="font-display text-sm w-5 text-center text-sun">{i + 1}</span>
                  <span className="text-base">{t.emoji}</span>
                  <span className="font-display text-xs flex-1 truncate" style={{ color: t.color }}>{t.name}</span>
                  <span className="font-display text-base" style={{ color: t.color }}>{t.score}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {sortedTeams.length === 0 && (
          <div className="sticker py-1.5">
            <p className="font-display text-[10px] uppercase tracking-widest text-center opacity-80 mb-1">
              Pontuação final
            </p>
            <ul className="space-y-0.5">
              {sorted.map((p, i) => (
                <li key={p.id} className="flex items-center gap-2 px-2">
                  <span className="font-display text-xs w-5 text-center opacity-70">{i + 1}º</span>
                  <span className="text-base">{p.avatar}</span>
                  <span className="font-display text-xs flex-1 truncate">{p.nickname}</span>
                  <span className="font-display text-xs text-primary">{p.score} pts</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-1.5">
          <p className="font-display text-[10px] uppercase tracking-widest text-center opacity-80">
            🏆 Pódio
          </p>
          {isGuest && (
            <motion.div
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.4 }}
              className="rounded-2xl border-2 border-pink/40 p-3 flex items-center gap-3"
              style={{
                background: "linear-gradient(135deg, color-mix(in oklab, var(--pink) 12%, transparent), color-mix(in oklab, var(--sun) 10%, transparent))",
                boxShadow: "0 6px 18px -8px color-mix(in oklab, var(--pink) 50%, transparent)",
              }}
            >
              <div className="text-2xl shrink-0" aria-hidden>🏅</div>
              <div className="flex-1 min-w-0">
                <p className="font-display text-sm leading-tight">
                  Crie uma conta para entrar no ranking!
                </p>
                <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                  Você fez <span className="font-display text-pink">{myFinalScore} pts</span>, mas como convidado eles não contam no ranking global. Próximas partidas vão acumular.
                </p>
              </div>
              <Link
                to="/login"
                className="btn-pop bg-gradient-fun text-white text-xs px-3 py-2 font-display shrink-0"
              >
                Criar conta
              </Link>
            </motion.div>
          )}
          {titles.map(({ title, desc, player, medal, tone }, idx) => {
            if (!player) return null;
            const team = sortedTeams.length > 0 ? (room.teams ?? []).find((t) => t.id === player.team_id) : undefined;
            const isGold = idx === 0;
            return (
              <motion.div
                key={title}
                initial={{ y: 20, opacity: 0, scale: isGold ? 0.9 : 1 }}
                animate={{ y: 0, opacity: 1, scale: 1 }}
                transition={{ delay: 0.2 + idx * 0.15, type: "spring", stiffness: 200 }}
                className={"rounded-2xl flex flex-col gap-0.5 border-2 " + (isGold ? "py-2.5 px-3" : "py-1.5 px-2.5")}
                style={{
                  borderColor: tone,
                  backgroundColor: isGold ? `${tone}22` : `${tone}14`,
                  boxShadow: isGold ? `0 0 24px ${tone}77, inset 0 0 12px ${tone}33` : `0 0 8px ${tone}33`,
                }}
              >
                <div className="flex items-center gap-2">
                  <motion.span
                    animate={isGold ? { rotate: [0, -8, 8, -4, 4, 0], scale: [1, 1.15, 1] } : undefined}
                    transition={isGold ? { duration: 1.2, repeat: Infinity, repeatDelay: 2 } : undefined}
                    className={"shrink-0 leading-none " + (isGold ? "text-4xl" : "text-2xl")}
                    style={{ filter: `drop-shadow(0 0 8px ${tone})` }}
                  >
                    {medal}
                  </motion.span>
                  <div className="flex-1 min-w-0">
                    <span className={"font-display block leading-tight " + (isGold ? "text-sm" : "text-xs")} style={{ color: tone }}>{title}</span>
                    <p className="text-[10px] text-muted-foreground italic leading-tight">{desc}</p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <div className="flex items-center gap-1">
                      <span className={isGold ? "text-xl" : "text-base"}>{player.avatar}</span>
                      <span className={"font-display " + (isGold ? "text-sm" : "text-xs")}>{player.nickname}</span>
                    </div>
                    <span className="font-display text-[11px] tabular-nums" style={{ color: tone }}>
                      {player.score} pts
                    </span>
                    {sortedTeams.length > 0 && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-display border leading-none"
                        style={{
                          color: team?.color ?? "rgba(255,255,255,0.55)",
                          borderColor: team?.color ?? "rgba(255,255,255,0.18)",
                          backgroundColor: team ? `${team.color}1a` : "rgba(255,255,255,0.06)",
                        }}
                      >
                        <span>{team?.emoji ?? "—"}</span>
                        <span className="truncate max-w-[80px]">{team?.name ?? "sem time"}</span>
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>


      </div>

      <div className="flex gap-2 mt-2 pt-2 border-t border-white/10 bg-background/80 backdrop-blur-sm sticky bottom-0">
        <button onClick={onLeave} className="btn-pop bg-card flex-1">Sair</button>
        <button
          onClick={() => setViewingScoreboard(true)}
          className="btn-pop bg-card flex-1 text-sm"
          title="Rever placar da última rodada">
          📊 Ver placar
        </button>
        {isHost && (
          <button onClick={() => restartGame(roomId)} className="btn-pop bg-gradient-fun text-white flex-[2] text-lg">
            🔄 Nova partida
          </button>
        )}
      </div>

    </motion.div>
  );
}

export default Finished;


