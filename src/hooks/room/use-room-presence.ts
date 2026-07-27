// Módulo: merge da presença realtime na lista de jogadores.
// Bots permanecem sempre "conectados" (não trackeiam presença).
// Memoizado para preservar identidade de referência quando nem `players`
// nem `presenceMap` mudaram — evita re-renders em cascata nos filhos
// (listas de jogadores, cédulas etc.) a cada tick de timer/voto.
import { useMemo } from "react";
import type { Player } from "@/lib/room";
import type { RoomCtx } from "./ctx";

export function useRoomPresence(ctx: RoomCtx): Player[] {
  const { players, presenceMap } = ctx;
  return useMemo(() => {
    let changed = false;
    const out = players.map((p) => {
      if (p.is_bot) return p;
      const present = presenceMap[p.id];
      if (present === undefined) return p;
      if (p.is_connected === present) return p;
      changed = true;
      return { ...p, is_connected: present };
    });
    return changed ? out : players;
  }, [players, presenceMap]);
}
