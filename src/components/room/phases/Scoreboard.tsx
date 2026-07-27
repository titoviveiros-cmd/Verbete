import { memo, useEffect, useMemo, useRef, useState } from "react";
import { hapticSuccess } from "@/lib/sound";
import { getPlayerId } from "@/lib/player-id";
import { scalePhaseSecs } from "@/lib/game-times";
import { motion } from "framer-motion";
import {
  nextRound,
  computeTeamScores,
  type Definition,
  type Player,
  type Room,
  type Vote,
} from "@/lib/room";
import { PHASE_ANNOUNCER_TOTAL_MS } from "@/components/room/PhaseAnnouncer";
import { scrollbarClip } from "@/lib/utils";

// Contador rolante (Fase 4, aprovado): o número "sobe" do placar anterior
// para o novo com easing — dá a sensação de pontos sendo somados ao vivo.
function AnimatedNumber({
  value,
  from,
  duration = 900,
}: {
  value: number;
  from?: number;
  duration?: number;
}) {
  const [display, setDisplay] = useState(from ?? value);
  useEffect(() => {
    const start = from ?? value;
    if (start === value) {
      setDisplay(value);
      return;
    }
    const t0 = performance.now();
    const iv = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / duration);
      setDisplay(
        Math.round(start + (value - start) * (1 - Math.pow(1 - k, 3))),
      );
      if (k >= 1) clearInterval(iv);
    }, 40);
    return () => clearInterval(iv);
  }, [value, from, duration]);
  return <>{display}</>;
}

function ScoreboardImpl({
  room,
  players,
  isHost,
}: {
  room: Room;
  players: Player[];
  isHost: boolean;
}) {
  const sorted = useMemo(
    () => [...players].sort((a, b) => b.score - a.score),
    [players],
  );
  const [history, setHistory] = useState<{
    defs: Definition[];
    votes: Vote[];
    rounds: { round: number; coordinator_id: string; scored_at: string }[];
    nearTruthIds: Set<string>;
    extensions: { player_id: string; round: number; attempt: number }[];
  } | null>(null);

  // Hold escala com o nº de jogadores (7-12): mais fileiras para ler.
  const SCORE_HOLD = scalePhaseSecs(8, players.length);
  const [scoreTransitionDone, setScoreTransitionDone] = useState(false);
  useEffect(() => {
    setScoreTransitionDone(false);
    const t = setTimeout(
      () => setScoreTransitionDone(true),
      PHASE_ANNOUNCER_TOTAL_MS,
    );
    return () => clearTimeout(t);
  }, [room.current_round]);
  const [holdLeft, setHoldLeft] = useState(SCORE_HOLD);
  useEffect(() => {
    if (!scoreTransitionDone) return;
    setHoldLeft(SCORE_HOLD);
    const iv = setInterval(() => setHoldLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(iv);
  }, [room.current_round, scoreTransitionDone]);

  // Sem auto-avanço no client (feedback de playtest: tirava a serventia
  // do botão). O host decide quando seguir; se estiver ausente, o cron
  // server-side avança sozinho após o hold — backstop já existente.

  // Fase 4 (aprovado): coreografia de "ultrapassagem" — as fileiras entram
  // na ordem da rodada ANTERIOR e deslizam para as novas posições, com o
  // placar rolando (prev → atual) e pulso em quem subiu.
  const [reordered, setReordered] = useState(false);
  useEffect(() => {
    setReordered(false);
  }, [room.current_round]);
  useEffect(() => {
    if (!scoreTransitionDone || !history) return;
    const t = setTimeout(() => setReordered(true), 900);
    return () => clearTimeout(t);
  }, [scoreTransitionDone, history, room.current_round]);

  useEffect(() => {
    (async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const [
        { data: defs },
        { data: votes },
        { data: rounds },
        { data: reveal },
        { data: exts },
      ] = await Promise.all([
        // S1: leitura direta de definitions foi revogada — RPC devolve as
        // rodadas já reveladas (a corrente só a partir do reveal).
        supabase.rpc("get_room_definitions", { p_room_id: room.id }),
        supabase.from("votes").select("*").eq("room_id", room.id),
        supabase
          .from("rounds")
          .select("round,coordinator_id,scored_at")
          .eq("room_id", room.id),
        supabase.rpc("get_room_reveal", { p_room_id: room.id }),
        supabase
          .from("round_extensions")
          .select("player_id,round,attempt")
          .eq("room_id", room.id),
      ]);
      const nearIds: string[] =
        (reveal as { near_truth_ids?: string[] } | null)?.near_truth_ids ?? [];
      setHistory({
        defs: (defs ?? []) as unknown as Definition[],
        votes: (votes ?? []) as Vote[],
        rounds: (rounds ?? []) as {
          round: number;
          coordinator_id: string;
          scored_at: string;
        }[],
        nearTruthIds: new Set(nearIds),
        extensions: (exts ?? []) as {
          player_id: string;
          round: number;
          attempt: number;
        }[],
      });
    })();
  }, [room.id, room.current_round]);

  // Alinhado com o servidor: o score persistido em `players.score` é calculado
  // a partir de TODOS os votos da rodada (sem filtro de tolerância). Para que
  // a soma do breakdown bata com o total exibido, usamos a mesma base aqui.
  const countedVotes = useMemo<Vote[]>(() => history?.votes ?? [], [history]);

  const breakdownByPlayer = useMemo(() => {
    const out = new Map<string, string[]>();
    if (!history) return out;
    const truthDefIds = new Set(
      history.defs.filter((d) => d.player_id === "__truth__").map((d) => d.id),
    );
    const allRounds = Array.from(new Set(history.defs.map((d) => d.round)));
    const votesByVoter = new Map<string, number>();
    const votesByDefId = new Map<string, number>();
    const truthHitsByVoter = new Map<string, number>();
    for (const v of countedVotes) {
      votesByDefId.set(
        v.definition_id,
        (votesByDefId.get(v.definition_id) ?? 0) + 1,
      );
      if (truthDefIds.has(v.definition_id)) {
        truthHitsByVoter.set(
          v.voter_id,
          (truthHitsByVoter.get(v.voter_id) ?? 0) + 1,
        );
      }
      votesByVoter.set(v.voter_id, (votesByVoter.get(v.voter_id) ?? 0) + 1);
    }

    for (const p of players) {
      const reasons: string[] = [];
      const truthHits = truthHitsByVoter.get(p.id) ?? 0;
      if (truthHits > 0)
        reasons.push(
          `🎯 Acertou a verdade ${truthHits}× → +${truthHits * 3} pts`,
        );
      const myFakeDefs = history.defs.filter(
        (d) => d.player_id === p.id && !(d.player_id === "__truth__"),
      );
      let foolsCount = 0;
      for (const d of myFakeDefs) foolsCount += votesByDefId.get(d.id) ?? 0;
      if (foolsCount > 0)
        reasons.push(
          `🤥 Enganou jogadores ${foolsCount}× → +${foolsCount} pts`,
        );
      const nearHits = myFakeDefs.filter((d) =>
        history.nearTruthIds.has(d.id),
      ).length;
      if (nearHits > 0)
        reasons.push(
          `🧠 Chegou perto da verdade ${nearHits}× → +${nearHits * 3} pts`,
        );
      let coordWins = 0;
      for (const r of allRounds) {
        const truthDef = history.defs.find(
          (d) => d.round === r && d.player_id === "__truth__",
        );
        if (!truthDef) continue;
        const someoneHit = countedVotes.some(
          (v) => v.round === r && v.definition_id === truthDef.id,
        );
        const roundRow = history.rounds.find((rr) => rr.round === r);
        const coordinatorOfR = roundRow?.coordinator_id;
        let isCoordOfR: boolean;
        if (coordinatorOfR) {
          isCoordOfR = coordinatorOfR === p.id;
        } else {
          const writerIds = new Set(
            history.defs
              .filter((d) => d.round === r && !(d.player_id === "__truth__"))
              .map((d) => d.player_id),
          );
          isCoordOfR = !writerIds.has(p.id);
        }
        if (isCoordOfR && !someoneHit) coordWins++;
      }
      if (coordWins > 0)
        reasons.push(
          `👑 Coordenou e ninguém acertou ${coordWins}× → +${coordWins * 2} pts`,
        );
      const penalties = history.extensions.filter(
        (e) => e.player_id === p.id,
      ).length;
      if (penalties > 0)
        reasons.push(`⏰ Estourou o tempo ${penalties}× → -${penalties} pts`);
      if (reasons.length === 0)
        reasons.push("Ainda sem pontos — bora pra próxima! 💪");
      out.set(p.id, reasons);
    }
    return out;
  }, [history, players, countedVotes]);
  const breakdown = (playerId: string): string[] =>
    breakdownByPlayer.get(playerId) ?? [];

  // Delta da RODADA ATUAL por jogador — usado para reconstruir o placar
  // anterior (prev = atual − delta) e coreografar a ultrapassagem.
  const roundDeltaByPlayer = useMemo(() => {
    const map = new Map<string, number>();
    if (!history) return map;
    const r = room.current_round;
    const truthDef = history.defs.find(
      (d) => d.round === r && d.player_id === "__truth__",
    );
    for (const p of players) {
      let d = 0;
      if (truthDef)
        d +=
          3 *
          countedVotes.filter(
            (v) =>
              v.round === r &&
              v.definition_id === truthDef.id &&
              v.voter_id === p.id,
          ).length;
      const myDefs = history.defs.filter(
        (dd) => dd.round === r && dd.player_id === p.id,
      );
      for (const md of myDefs) {
        d += countedVotes.filter((v) => v.definition_id === md.id).length;
        if (history.nearTruthIds.has(md.id)) d += 3;
      }
      const roundRow = history.rounds.find((rr) => rr.round === r);
      if (roundRow?.coordinator_id === p.id && truthDef) {
        const someoneHit = countedVotes.some(
          (v) => v.round === r && v.definition_id === truthDef.id,
        );
        if (!someoneHit) d += 2;
      }
      d -= history.extensions.filter(
        (e) => e.player_id === p.id && e.round === r,
      ).length;
      map.set(p.id, d);
    }
    return map;
  }, [history, players, countedVotes, room.current_round]);

  const prevScore = (p: Player) =>
    Math.max(0, p.score - (roundDeltaByPlayer.get(p.id) ?? 0));

  // Antes da coreografia: ordem/valores da rodada anterior. Depois: atuais.
  const displaySorted = useMemo(() => {
    if (reordered || !history) return sorted;
    return [...players].sort((a, b) => prevScore(b) - prevScore(a));
  }, [reordered, history, players, sorted, roundDeltaByPlayer]);

  const prevRank = useMemo(() => {
    const m = new Map<string, number>();
    [...players]
      .sort((a, b) => prevScore(b) - prevScore(a))
      .forEach((p, i) => m.set(p.id, i));
    return m;
  }, [players, roundDeltaByPlayer]);
  const newRank = useMemo(() => {
    const m = new Map<string, number>();
    sorted.forEach((p, i) => m.set(p.id, i));
    return m;
  }, [sorted]);

  // Fase 5: se EU subi de posição na ultrapassagem, sinto o sucesso no tato.
  const riseHapticRound = useRef<number | null>(null);
  useEffect(() => {
    if (!reordered || riseHapticRound.current === room.current_round) return;
    riseHapticRound.current = room.current_round;
    const myId = getPlayerId();
    if (!myId) return;
    if ((newRank.get(myId) ?? 99) < (prevRank.get(myId) ?? 99)) {
      setTimeout(() => hapticSuccess(), 400); // junto com o deslize da fileira
    }
  }, [reordered, room.current_round, newRank, prevRank]);

  const sortedTeams = useMemo(
    () =>
      room.mode === "teams" && (room.teams?.length ?? 0) > 0
        ? computeTeamScores(players, room.teams ?? []).sort(
            (a, b) => b.score - a.score,
          )
        : [],
    [room.mode, room.teams, players],
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex-1 min-h-0 flex flex-col gap-3 pt-2 overflow-x-hidden w-full max-w-full"
    >
      <div className="shrink-0">
        <h2 className="font-display text-4xl text-center text-sun leading-tight">
          Placar 📊
        </h2>
        <p className="text-center text-base text-muted-foreground mt-1">
          {sortedTeams.length > 0
            ? "Pontuação por equipe e por jogador:"
            : "Como cada um pontuou:"}
        </p>
      </div>
      <div
        className="flex-1 min-h-0 space-y-3 overflow-y-auto overflow-x-hidden no-scrollbar pb-3 w-full max-w-full"
        style={scrollbarClip()}
      >
        {sortedTeams.length > 0 && (
          <div className="sticker py-3">
            <p className="font-display text-sm uppercase tracking-widest text-center opacity-80 mb-2">
              🏁 Ranking por equipe
            </p>
            <ul className="space-y-1.5">
              {sortedTeams.map((t, i) => {
                const medal =
                  i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : null;
                return (
                  <li key={t.id} className="flex items-center gap-3 px-2">
                    <span className="font-display text-lg w-6 text-center text-sun">
                      {medal ?? i + 1}
                    </span>
                    <span className="text-2xl">{t.emoji}</span>
                    <span
                      className="font-display flex-1 truncate"
                      style={{ color: t.color }}
                    >
                      {t.name}
                    </span>
                    <span
                      className="font-display text-2xl"
                      style={{ color: t.color }}
                    >
                      {t.score}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {displaySorted.map((p, i) => {
          const team =
            sortedTeams.length > 0
              ? (room.teams ?? []).find((t) => t.id === p.team_id)
              : undefined;
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : null;
          const tone =
            i === 0
              ? "#FFD166"
              : i === 1
                ? "#C0C0C0"
                : i === 2
                  ? "#CD7F32"
                  : null;
          // Subiu de posição nesta rodada → pulso de destaque na chegada.
          const riser =
            reordered && (newRank.get(p.id) ?? 0) < (prevRank.get(p.id) ?? 0);
          return (
            <motion.div
              key={p.id}
              layout
              initial={{ x: -30, opacity: 0 }}
              animate={
                riser
                  ? { x: 0, opacity: 1, scale: [1, 1.04, 1] }
                  : { x: 0, opacity: 1 }
              }
              transition={{
                delay: reordered ? 0 : i * 0.06,
                layout: { type: "spring", stiffness: 240, damping: 26 },
                scale: { duration: 0.8, times: [0, 0.4, 1] },
              }}
              className="sticker"
              style={
                tone
                  ? {
                      borderColor: riser ? "#FFDE00" : tone,
                      boxShadow:
                        i === 0 ? `0 0 18px ${tone}55` : `0 0 8px ${tone}33`,
                    }
                  : riser
                    ? {
                        borderColor: "#FFDE00",
                        boxShadow: "0 0 14px #ffde0055",
                      }
                    : undefined
              }
            >
              <div className="flex items-center gap-3">
                <span
                  className={
                    "font-display w-10 text-center " +
                    (medal ? "text-3xl leading-none" : "text-3xl text-sun")
                  }
                  style={
                    medal
                      ? { filter: `drop-shadow(0 0 6px ${tone})` }
                      : undefined
                  }
                >
                  {medal ?? i + 1}
                </span>
                <div className="text-3xl">{p.avatar}</div>
                <div className="flex-1 min-w-0">
                  <span className="font-display text-xl truncate block">
                    {p.nickname}
                  </span>
                  {sortedTeams.length > 0 && (
                    <span
                      className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-[11px] font-display border max-w-full"
                      style={{
                        color: team?.color ?? "rgba(255,255,255,0.55)",
                        borderColor: team?.color ?? "rgba(255,255,255,0.18)",
                        backgroundColor: team
                          ? `${team.color}1a`
                          : "rgba(255,255,255,0.06)",
                      }}
                    >
                      <span>{team?.emoji ?? "—"}</span>
                      <span className="truncate">
                        {team?.name ?? "sem time"}
                      </span>
                    </span>
                  )}
                </div>
                <span
                  className="font-display text-3xl tabular-nums"
                  style={{ color: tone ?? undefined }}
                >
                  {reordered ? (
                    <AnimatedNumber from={prevScore(p)} value={p.score} />
                  ) : (
                    prevScore(p)
                  )}
                </span>
              </div>
              <ul className="mt-2 pl-14 space-y-1">
                {breakdown(p.id).map((r, idx) => (
                  <li
                    key={idx}
                    className="text-sm text-muted-foreground font-body"
                  >
                    • {r}
                  </li>
                ))}
              </ul>
              {history &&
                (() => {
                  const myFakes = history.defs.filter(
                    (d) =>
                      d.player_id === p.id && !(d.player_id === "__truth__"),
                  );
                  const fooled: {
                    round: number;
                    text: string;
                    voters: Player[];
                  }[] = [];
                  for (const d of myFakes) {
                    const voters = countedVotes
                      .filter((v) => v.definition_id === d.id)
                      .map((v) => players.find((pp) => pp.id === v.voter_id))
                      .filter((x): x is Player => Boolean(x));

                    if (voters.length)
                      fooled.push({ round: d.round, text: d.text, voters });
                  }
                  if (!fooled.length) return null;
                  return (
                    <div className="mt-3 pl-14">
                      <p className="text-xs font-display text-pink mb-1">
                        🪤 caíram na sua pegadinha:
                      </p>
                      <ul className="space-y-1">
                        {fooled.map((f, i) => (
                          <li key={i} className="text-sm font-body">
                            <span className="text-muted-foreground">
                              R{f.round} "{f.text}" →
                            </span>{" "}
                            {f.voters.map((v, j) => (
                              <span key={j} className="font-display mr-1">
                                {v.avatar} {v.nickname}
                                {j < f.voters.length - 1 ? "," : ""}
                              </span>
                            ))}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}
            </motion.div>
          );
        })}
      </div>
      {isHost ? (
        <button
          onClick={() => nextRound(room, players)}
          className="btn-pop bg-gradient-fun text-white text-2xl py-3 shrink-0"
        >
          ▶ Próxima rodada
        </button>
      ) : (
        <p className="text-center text-muted-foreground italic shrink-0">
          {holdLeft > 0
            ? `Lendo o placar… ${holdLeft}s`
            : "Aguardando o host continuar…"}
        </p>
      )}
    </motion.div>
  );
}

export const Scoreboard = memo(ScoreboardImpl);
export default Scoreboard;
