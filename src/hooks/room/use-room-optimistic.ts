// Módulo: atualizações OTIMISTAS via CustomEvent do window.
// As ações (lib/room.ts) disparam eventos para a UI reagir instantaneamente,
// sem esperar o round-trip do banco nem o echo do realtime. O merge com o
// estado real acontece nos reducers do realtime/polling (dedupe por id).
import { useEffect } from "react";
import type { Room, Player, Definition, Vote } from "@/lib/room";
import type { RoomCtx } from "./ctx";

export function useRoomOptimistic(ctx: RoomCtx) {
  const {
    room,
    setRoom,
    setPlayers,
    setDefinitions,
    setVotes,
    optimisticPlayerIdsRef,
  } = ctx;
  const roomId = room?.id;

  useEffect(() => {
    if (!roomId) return;
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { roomId?: string; player?: Player }
        | undefined;
      if (!detail?.player || detail.roomId !== roomId) return;
      optimisticPlayerIdsRef.current[detail.player.id] = Date.now();
      setPlayers((cur) =>
        cur.some((p) => p.id === detail.player!.id)
          ? cur
          : [...cur, detail.player!],
      );
    };
    const onRemove = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { playerId?: string }
        | undefined;
      if (!detail?.playerId) return;
      delete optimisticPlayerIdsRef.current[detail.playerId];
      setPlayers((cur) => cur.filter((p) => p.id !== detail.playerId));
    };
    const onDefAdd = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { roomId?: string; definition?: Definition }
        | undefined;
      if (!detail?.definition || detail.roomId !== roomId) return;
      const incoming = detail.definition;
      setDefinitions((cur) => {
        // Evita duplicata se já existe linha real para este jogador/rodada.
        if (
          cur.some(
            (d) =>
              d.player_id === incoming.player_id && d.round === incoming.round,
          )
        )
          return cur;
        return [...cur, incoming];
      });
    };
    const onVoteAdd = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { roomId?: string; vote?: Vote }
        | undefined;
      if (!detail?.vote || detail.roomId !== roomId) return;
      const incoming = detail.vote;
      setVotes((cur) => {
        if (
          cur.some(
            (v) =>
              v.voter_id === incoming.voter_id && v.round === incoming.round,
          )
        )
          return cur;
        return [...cur, incoming];
      });
    };
    const onDefsReplaceRound = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { roomId?: string; round?: number; definitions?: Definition[] }
        | undefined;
      if (
        !detail?.definitions ||
        detail.roomId !== roomId ||
        typeof detail.round !== "number"
      )
        return;
      setDefinitions((cur) => [
        ...cur.filter((d) => d.round !== detail.round),
        ...detail.definitions!,
      ]);
    };
    const onDefRollback = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { roomId?: string; pendingId?: string }
        | undefined;
      if (!detail?.pendingId || detail.roomId !== roomId) return;
      setDefinitions((cur) => cur.filter((d) => d.id !== detail.pendingId));
    };
    const onVoteRollback = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { roomId?: string; pendingId?: string }
        | undefined;
      if (!detail?.pendingId || detail.roomId !== roomId) return;
      setVotes((cur) => cur.filter((v) => v.id !== detail.pendingId));
    };
    const onRoomUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { roomId?: string; patch?: Partial<Room> }
        | undefined;
      if (!detail?.patch || detail.roomId !== roomId) return;
      setRoom((cur) => (cur ? ({ ...cur, ...detail.patch } as Room) : cur));
    };
    const onPlayerUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { playerId?: string; patch?: Partial<Player> }
        | undefined;
      if (!detail?.playerId || !detail.patch) return;
      setPlayers((cur) =>
        cur.map((p) =>
          p.id === detail.playerId ? ({ ...p, ...detail.patch } as Player) : p,
        ),
      );
    };
    const onPlayersClearTeam = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { roomId?: string }
        | undefined;
      if (detail?.roomId !== roomId) return;
      setPlayers((cur) => cur.map((p) => ({ ...p, team_id: null })));
    };
    const listeners: Array<[string, EventListener]> = [
      ["player:optimistic-add", onAdd as EventListener],
      ["player:optimistic-remove", onRemove as EventListener],
      ["player:optimistic-update", onPlayerUpdate as EventListener],
      ["players:optimistic-clear-team", onPlayersClearTeam as EventListener],
      ["room:optimistic-update", onRoomUpdate as EventListener],
      ["definition:optimistic-add", onDefAdd as EventListener],
      [
        "definitions:optimistic-replace-round",
        onDefsReplaceRound as EventListener,
      ],
      ["vote:optimistic-add", onVoteAdd as EventListener],
      ["definition:optimistic-rollback", onDefRollback as EventListener],
      ["vote:optimistic-rollback", onVoteRollback as EventListener],
    ];
    for (const [name, fn] of listeners) window.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of listeners) window.removeEventListener(name, fn);
    };
    // setters/refs são estáveis; só o id da sala altera o wiring
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);
}
