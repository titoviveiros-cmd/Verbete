// Orquestrador do estado da sala (Fase 10 · parte 2): é o ÚNICO dono do
// estado; os módulos em hooks/room/ recebem o RoomCtx e ligam seus efeitos.
import { useEffect, useRef, useState } from "react";
import type { Room, Player, Definition, Vote, Word } from "@/lib/room";
import { setOpsRoom } from "@/lib/ops";
import type { RoomCtx } from "@/hooks/room/ctx";
import { useRoomOptimistic } from "@/hooks/room/use-room-optimistic";
import { useRoomRealtime } from "@/hooks/room/use-room-realtime";
import { useRoomPolling } from "@/hooks/room/use-room-polling";
import { useRoomData } from "@/hooks/room/use-room-data";
import { useRoomPresence } from "@/hooks/room/use-room-presence";

export interface RoundExtension {
  id: string;
  room_id: string;
  round: number;
  player_id: string;
  attempt: number;
  applied_at: string;
  phase?: "writing" | "voting";
}

export function useRoom(code: string | undefined, playerId?: string) {
  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [word, setWord] = useState<Word | null>(null);
  const [roundExtensions, setRoundExtensions] = useState<RoundExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Fase 3 (ConnectionState): true quando o servidor está inalcançável
  // (poll falhando ou navegador offline) — a TopBar mostra "reconectar".
  const [degraded, setDegraded] = useState(false);
  // Local override of is_connected derived from realtime presence.
  // Keys are player ids; values true=connected, false=disconnected.
  const [presenceMap, setPresenceMap] = useState<Record<string, boolean>>({});

  // Fase 8: eventos de telemetria carregam o hash da sala atual.
  useEffect(() => {
    setOpsRoom(code ?? null);
    return () => setOpsRoom(null);
  }, [code]);

  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const optimisticPlayerIdsRef = useRef<Record<string, number>>({});
  // Última vez que recebemos QUALQUER evento realtime (postgres_changes ou
  // broadcast). Usado pelo poll adaptativo abaixo para só recarregar quando
  // o canal está realmente silencioso.
  const lastEventAtRef = useRef<number>(Date.now());
  // Última versão de status/round que conhecemos — usada para deduplicar
  // broadcasts de relay e disparar reload imediato quando há divergência.
  const lastRoomSigRef = useRef<string>("");
  // Mantém ref atualizada de `players` para consumo dentro de callbacks de
  // realtime (que capturariam estado obsoleto se usassem a variável direto).
  const playersRef = useRef<Player[]>([]);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);
  const roomRef = useRef<Room | null>(null);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  // Contexto compartilhado com os módulos (Fase 10 · parte 2). O objeto é
  // recriado a cada render, mas os efeitos dos módulos dependem dos MESMOS
  // primitivos de antes (room?.id etc.) — comportamento idêntico ao monólito.
  const ctx: RoomCtx = {
    code,
    playerId,
    room,
    setRoom,
    players,
    setPlayers,
    definitions,
    setDefinitions,
    votes,
    setVotes,
    word,
    setWord,
    roundExtensions,
    setRoundExtensions,
    setLoading,
    setError,
    setDegraded,
    presenceMap,
    setPresenceMap,
    reloadRef,
    optimisticPlayerIdsRef,
    lastEventAtRef,
    lastRoomSigRef,
    playersRef,
    roomRef,
  };

  // Módulos (mesma ordem de efeitos do monólito original):
  // 1. dados — carga inicial (popula reloadRef), rodada e palavra
  useRoomData(ctx);
  // 2. canal realtime — postgres_changes + broadcast + presença
  useRoomRealtime(ctx);
  // 3. atualizações otimistas via CustomEvent
  useRoomOptimistic(ctx);
  // 4. polling, retomada de aba e conexão
  useRoomPolling(ctx);
  // 5. merge da presença na lista de jogadores
  const playersWithPresence = useRoomPresence(ctx);

  const reload = () => {
    reloadRef.current?.();
  };

  return {
    room,
    players: playersWithPresence,
    definitions,
    votes,
    word,
    roundExtensions,
    loading,
    error,
    degraded,
    reload,
  };
}
