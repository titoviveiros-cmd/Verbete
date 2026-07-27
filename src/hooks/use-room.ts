import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Room, Player, Definition, Vote, Word } from "@/lib/room";
import { reportOpsEvent, setOpsRoom } from "@/lib/ops";
import type { RoomCtx } from "@/hooks/room/ctx";
import { useRoomOptimistic } from "@/hooks/room/use-room-optimistic";
import { useRoomRealtime } from "@/hooks/room/use-room-realtime";
import { useRoomPolling } from "@/hooks/room/use-room-polling";

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

  // Initial load — single RPC roundtrip
  useEffect(() => {
    if (!code) return;
    let alive = true;
    const load = async () => {
      const { data, error: rpcErr } = await supabase.rpc("get_room_state", {
        p_code: code,
      });
      if (!alive) return;
      if (!rpcErr && data) {
        const payload = data as unknown as {
          room: Room;
          players: Player[];
          definitions: Definition[];
          votes: Vote[];
          word: Word | null;
        };
        if (!payload?.room) {
          setError("Sala não encontrada");
          setLoading(false);
          return;
        }
        setRoom(payload.room);
        lastRoomSigRef.current = `${payload.room.status}|${payload.room.current_round}|${payload.room.current_word_id ?? ""}`;
        lastEventAtRef.current = Date.now();
        setPlayers((payload.players ?? []).filter((p) => !p.kicked_at));
        setDefinitions(payload.definitions ?? []);
        setVotes(payload.votes ?? []);
        setWord(payload.word ?? null);
        // round_extensions é carregado separadamente — não vem no RPC.
        supabase
          .from("round_extensions")
          .select("*")
          .eq("room_id", payload.room.id)
          .then(({ data }) => {
            if (alive) setRoundExtensions((data as RoundExtension[]) ?? []);
          });
        setLoading(false);
        return;
      }
      // Fallback legado (RPC indisponível)
      const { data: r, error: e } = await supabase
        .from("rooms")
        .select("*")
        .eq("code", code)
        .maybeSingle();
      if (!alive) return;
      if (e || !r) {
        setError(e?.message ?? "Sala não encontrada");
        setLoading(false);
        return;
      }
      setRoom(r as unknown as Room);
      const [{ data: ps }, { data: sync }, { data: rxs }] = await Promise.all([
        supabase
          .from("players")
          .select("*")
          .eq("room_id", r.id)
          .is("kicked_at", null)
          .order("joined_at"),
        supabase.rpc("get_round_sync", { p_room_id: r.id }),
        supabase.from("round_extensions").select("*").eq("room_id", r.id),
      ]);
      if (!alive) return;
      setPlayers((ps as Player[]) ?? []);
      const syncPayload = sync as {
        definitions?: Definition[];
        votes?: Vote[];
      } | null;
      setDefinitions(syncPayload?.definitions ?? []);
      setVotes(syncPayload?.votes ?? []);
      setRoundExtensions((rxs as RoundExtension[]) ?? []);
      setLoading(false);
    };
    reloadRef.current = load;
    load();
    return () => {
      alive = false;
    };
  }, [code]);


  // Canal realtime (postgres_changes + broadcast + presence) — módulo próprio.
  useRoomRealtime(ctx);

  // Atualizações otimistas (CustomEvent) — módulo próprio.
  useRoomOptimistic(ctx);

  // Polling, retomada de aba e conexão — módulo próprio.
  useRoomPolling(ctx);

  // When round changes, refresh definitions/votes.
  // CRÍTICO: limpamos o estado IMEDIATAMENTE antes do refetch para evitar
  // que arrays stale da rodada anterior disparem `allVoted` e façam o host
  // chamar `revealAndScore` prematuramente na rodada nova (bug que zerava
  // o placar inteiro).
  useEffect(() => {
    if (!room?.id) return;
    setDefinitions([]);
    setVotes([]);
    (async () => {
      const { data: sync } = await supabase.rpc("get_round_sync", {
        p_room_id: room.id,
      });
      const payload = sync as {
        definitions?: Definition[];
        votes?: Vote[];
      } | null;
      setDefinitions(payload?.definitions ?? []);
      setVotes(payload?.votes ?? []);
    })();
  }, [room?.id, room?.current_round]);

  // Load current word
  useEffect(() => {
    const wid = room?.current_word_id;
    if (!wid) {
      setWord(null);
      return;
    }
    (async () => {
      // Colunas seguras apenas — meaning/curiosidade são bloqueadas por grants
      // e chegam via get_word_reveal() somente após a revelação.
      const { data } = await supabase
        .from("words")
        .select("id,word,category,rarity,nivel,classe,pronuncia")
        .eq("id", wid)
        .maybeSingle();
      if (data) {
        setWord(data as unknown as Word);
        return;
      }
      const { data: cw } = await supabase
        .from("room_words")
        .select("id,word,meaning,category")
        .eq("id", wid)
        .maybeSingle();
      if (cw) {
        setWord({
          id: (cw as any).id,
          word: (cw as any).word,
          meaning: (cw as any).meaning,
          category: (cw as any).category ?? "custom",
          rarity: 2,
        } as Word);
      } else {
        setWord(null);
      }
    })();
  }, [room?.current_word_id]);

  // Merge presence into players (override is_connected for non-bots).
  // Bots always remain "connected" since they don't track presence.
  // Memoizado para preservar identidade de referência quando nem `players`
  // nem `presenceMap` mudaram — evita re-renders em cascata nos filhos
  // (listas de jogadores, cédulas etc.) a cada tick de timer/voto.
  const playersWithPresence = useMemo(() => {
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
