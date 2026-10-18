import { memo, useMemo } from "react";
import { motion } from "framer-motion";
import type { Definition, Player, Room, Vote } from "@/lib/room";

// "Placar ao vivo" — coluna lateral da sala no desktop (só ≥1024px): pontos
// e quem já jogou na fase, com os mesmos dados que a tela já tem: nada novo
// é buscado nem calculado além de ordenar e marcar.
function MesaSidebarImpl({
  room,
  players,
  definitions,
  votes,
  playerId,
}: {
  room: Room;
  players: Player[];
  definitions: Definition[];
  votes: Vote[];
  playerId: string;
}) {
  const ranked = useMemo(
    () => [...players].sort((a, b) => b.score - a.score),
    [players],
  );
  const submitted = useMemo(
    () => new Set(definitions.map((d) => d.player_id)),
    [definitions],
  );
  const voted = useMemo(
    () =>
      new Set(
        votes
          .filter((v) => v.round === room.current_round)
          .map((v) => v.voter_id),
      ),
    [votes, room.current_round],
  );

  const statusOf = (p: Player): { label: string; tone: string } | null => {
    if (p.id === room.current_coordinator && room.status !== "voting")
      return { label: "coordena", tone: "text-sun" };
    if (room.status === "writing")
      return submitted.has(p.id)
        ? { label: "enviou ✓", tone: "text-mint" }
        : { label: "escrevendo…", tone: "text-muted-foreground" };
    if (room.status === "voting")
      return voted.has(p.id)
        ? { label: "votou ✓", tone: "text-mint" }
        : { label: "votando…", tone: "text-muted-foreground" };
    return null;
  };

  return (
    <aside
      aria-label="Placar ao vivo"
      className="hidden lg:flex w-[300px] shrink-0 flex-col gap-3 min-h-0"
    >
      <div className="panel p-4 flex flex-col gap-3 min-h-0">
        <div className="flex items-center justify-between">
          <p className="eyebrow">Placar ao vivo</p>
          <p className="eyebrow">
            {players.length} {players.length === 1 ? "jogador" : "jogadores"}
          </p>
        </div>
        <ol className="flex flex-col gap-2 overflow-y-auto no-scrollbar min-h-0">
          {ranked.map((p, i) => {
            const st = statusOf(p);
            const isMe = p.id === playerId;
            return (
              <motion.li
                layout
                key={p.id}
                className={
                  "flex items-center gap-2.5 rounded-2xl px-2.5 py-2 border " +
                  (isMe
                    ? "border-pink/50 bg-pink/10"
                    : "border-transparent bg-white/[0.04]")
                }
              >
                <span
                  className={
                    "w-5 text-center font-display text-sm tabular-nums " +
                    (i === 0 ? "text-sun" : "text-muted-foreground")
                  }
                >
                  {i + 1}
                </span>
                <span
                  className="w-9 h-9 rounded-full flex items-center justify-center text-lg shrink-0"
                  style={{
                    background: `radial-gradient(circle at 30% 25%, ${p.color}cc, ${p.color})`,
                    boxShadow: "inset 0 -2px 0 rgb(0 0 0 / 0.25)",
                  }}
                  aria-hidden
                >
                  {p.avatar}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-display text-[15px] leading-tight truncate">
                    {p.is_bot ? "🤖 " : ""}
                    {p.nickname}
                    {isMe ? " (você)" : ""}
                  </span>
                  {st && (
                    <span className={"block text-[11px] font-bold " + st.tone}>
                      {st.label}
                    </span>
                  )}
                </span>
                <span className="font-display text-lg tabular-nums">
                  {p.score}
                </span>
              </motion.li>
            );
          })}
        </ol>
      </div>
    </aside>
  );
}

export const MesaSidebar = memo(MesaSidebarImpl);
