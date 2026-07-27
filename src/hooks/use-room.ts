import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Room, Player, Definition, Vote, Word } from "@/lib/room";
import { reportOpsEvent, setOpsRoom } from "@/lib/ops";
import type { RoomCtx } from "@/hooks/room/ctx";
import { useRoomOptimistic } from "@/hooks/room/use-room-optimistic";
import { useRoomRealtime } from "@/hooks/room/use-room-realtime";

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

  // Reconnect: refresh state when window regains focus or becomes visible.
  // Otimização mobile: usuários alternam de app o tempo todo. Só recarrega
  // se o canal está realmente silencioso (>5s sem eventos) — em condições
  // normais o realtime continua entregando enquanto a aba estava oculta e
  // a RPC `get_room_state` seria desperdício de banda/latência.
  useEffect(() => {
    if (!code) return;
    const handler = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastEventAtRef.current < 5000) return;
      reloadRef.current?.();
    };
    window.addEventListener("focus", handler);
    document.addEventListener("visibilitychange", handler);
    return () => {
      window.removeEventListener("focus", handler);
      document.removeEventListener("visibilitychange", handler);
    };
  }, [code]);

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

  // Fonte única de definições/votos durante as fases ativas: a RPC
  // get_round_sync devolve o shape que o servidor permite para a fase
  // (S1: sem texto na escrita, sem autor na votação, completo no reveal).
  useEffect(() => {
    if (!room?.id) return;
    if (!["writing", "shuffling", "voting", "reveal"].includes(room.status))
      return;
    let cancelled = false;
    const refreshRound = async () => {
      const { data: sync, error: syncErr } = await supabase.rpc(
        "get_round_sync",
        { p_room_id: room.id },
      );
      if (cancelled) return;
      // Fase 3 (ConnectionState): o poll é o batimento com o servidor —
      // falha liga o indicador de reconexão; sucesso desliga.
      setDegraded(!!syncErr);
      const payload = sync as {
        definitions?: Definition[];
        votes?: Vote[];
      } | null;
      if (!payload) return;
      setDefinitions(payload.definitions ?? []);
      setVotes(payload.votes ?? []);
    };
    refreshRound();
    const interval = room.status === "writing" ? 1200 : 700;
    const t = window.setInterval(refreshRound, interval);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [room?.id, room?.current_round, room?.status]);

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

  // Rede de segurança ADAPTATIVA. Em vez de recarregar cego a cada 12s
  // (caro, gera flicker), só dispara reload se o canal estiver "silencioso"
  // por > 25s — significando perda real de eventos. Em condições normais
  // o broadcast `room-sync` cura inconsistências em < 200ms.
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;
      if (Date.now() - lastEventAtRef.current > 25000) {
        reloadRef.current?.();
      }
    }, 8000);
    return () => clearInterval(t);
  }, [code]);

  // Poll RÁPIDO da assinatura da sala (status|round|word). É uma query
  // mínima (1 linha, 4 colunas) que dispara em ~2,5s e detecta qualquer
  // divergência local — fechando o gap quando o cliente perde um
  // postgres_changes E o broadcast `room-sync` dos peers (ex: aba que
  // estava em background e voltou, queda momentânea de WS, conexão lenta).
  // Sem isso, jogadores podiam ficar até 25s atrasados em relação ao host.
  useEffect(() => {
    if (!room?.id) return;
    const roomId = room.id;
    let cancelled = false;
    const t = setInterval(async () => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;
      // Em paralelo: assinatura da sala + lista de jogadores. A segunda é
      // necessária porque eventos INSERT em `players` ocasionalmente não
      // chegam via Realtime (canal frio recém-assinado, perda de WS), e
      // sem isso o host pode não ver alguém que entrou na sala.
      const [{ data }, { data: ps }, { data: rxs }] = await Promise.all([
        supabase
          .from("rooms")
          .select(
            "status,current_round,current_word_id,round_phase_ends_at,current_coordinator,host_id",
          )
          .eq("id", roomId)
          .maybeSingle(),
        supabase
          .from("players")
          .select("*")
          .eq("room_id", roomId)
          .is("kicked_at", null)
          .order("joined_at"),
        supabase
          .from("round_extensions")
          .select("*")
          .eq("room_id", roomId)
          .order("applied_at", { ascending: false })
          .limit(80),
      ]);
      if (cancelled) return;
      if (Array.isArray(rxs))
        setRoundExtensions((rxs as RoundExtension[]) ?? []);
      if (Array.isArray(ps)) {
        setPlayers((cur) => {
          const dbPlayers = ps as Player[];
          const dbIds = new Set(dbPlayers.map((p) => p.id));
          const now = Date.now();
          const pending = cur.filter((p) => {
            const addedAt = optimisticPlayerIdsRef.current[p.id];
            if (!addedAt) return false;
            if (dbIds.has(p.id)) {
              delete optimisticPlayerIdsRef.current[p.id];
              return false;
            }
            if (now - addedAt > 5000) {
              delete optimisticPlayerIdsRef.current[p.id];
              return false;
            }
            return true;
          });
          const nextPlayers =
            pending.length > 0 ? [...dbPlayers, ...pending] : dbPlayers;
          // Reconcilia: se IDs (set), contagem ou campos de jogo divergem, substitui.
          // Caso contrário, mantém referência para evitar re-render.
          if (cur.length !== nextPlayers.length) {
            lastEventAtRef.current = Date.now();
            return nextPlayers;
          }
          const curIds = new Set(cur.map((p) => p.id));
          for (const p of nextPlayers) {
            if (!curIds.has(p.id)) {
              lastEventAtRef.current = Date.now();
              return nextPlayers;
            }
            const old = cur.find((x) => x.id === p.id);
            if (
              old &&
              (old.score !== p.score ||
                old.writing_extensions !== p.writing_extensions ||
                old.voting_extensions !== p.voting_extensions ||
                old.kicked_at !== p.kicked_at ||
                old.is_connected !== p.is_connected)
            ) {
              lastEventAtRef.current = Date.now();
              return nextPlayers;
            }
          }
          return cur;
        });
      }
      if (!data) return;
      const sig = `${data.status}|${data.current_round}|${data.current_word_id ?? ""}`;
      if (sig === lastRoomSigRef.current) {
        // Mesma fase — só atualiza o timestamp de "vivo" para evitar
        // o reload pesado de 25s e patches campos secundários (timer,
        // coordenador) sem refazer toda a árvore.
        lastEventAtRef.current = Date.now();
        setRoom((cur) =>
          cur &&
          (cur.round_phase_ends_at !== data.round_phase_ends_at ||
            cur.current_coordinator !== data.current_coordinator ||
            cur.host_id !== data.host_id)
            ? ({ ...cur, ...data } as Room)
            : cur,
        );
        return;
      }
      // Divergência real — atualizamos a assinatura ANTES de recarregar
      // para evitar reentrância e disparamos um reload completo.
      lastRoomSigRef.current = sig;
      lastEventAtRef.current = Date.now();
      reloadRef.current?.();
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [room?.id]);

  // Navegador offline/online — sinal imediato para o ConnectionState.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOffline = () => setDegraded(true);
    const onOnline = () => {
      setDegraded(false);
      void reloadRef.current?.();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // Retomada da aba (playtest mobile): o iOS congela timers/realtime quando o
  // jogador troca de app; ao voltar, a UI mostrava fase/timer VELHOS por
  // segundos e um toque caía numa fase que já tinha virado no servidor
  // ("tempo acabou antes do seu voto" sem o tempo ter acabado na tela).
  // Sincroniza IMEDIATAMENTE ao ficar visível de novo.
  useEffect(() => {
    if (typeof document === "undefined") return;
    let hiddenAt = 0;
    const onResume = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (document.visibilityState !== "visible") return;
      // Playtest 20:15: o iOS mantém a aba viva por HORAS com o bundle
      // antigo — nenhuma correção nova chega a quem nunca recarrega.
      // Ausência longa (>15min) = recarga completa: bundle novo + estado
      // novo. A rodada de 15min atrás já era, nada a preservar.
      if (hiddenAt && Date.now() - hiddenAt > 15 * 60_000) {
        window.location.reload();
        return;
      }
      // Ausência mais curta (>60s): compara o build com o publicado e
      // recarrega sozinho se saiu versão nova enquanto a aba dormia.
      if (hiddenAt && Date.now() - hiddenAt > 60_000) {
        void import("@/lib/app-version").then((m) => m.reloadIfOutdated());
      }
      lastEventAtRef.current = 0; // canal esteve mudo — poll adaptativo acorda
      void reloadRef.current?.();
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("focus", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, []);

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
