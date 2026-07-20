import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Room, Player, Definition, Vote, Word } from "@/lib/room";

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

  // Initial load — single RPC roundtrip
  useEffect(() => {
    if (!code) return;
    let alive = true;
    const load = async () => {
      const { data, error: rpcErr } = await (supabase.rpc as any)(
        "get_room_state",
        { p_code: code },
      );
      if (!alive) return;
      if (!rpcErr && data) {
        const payload = data as {
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
        (supabase.rpc as any)("get_round_sync", { p_room_id: r.id }),
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

  // Realtime subscription (postgres changes + presence for connection tracking)
  useEffect(() => {
    if (!room?.id) return;
    const ch = supabase
      .channel(`room:${room.id}`, {
        config: {
          presence: {
            key: playerId || `anon-${Math.random().toString(36).slice(2)}`,
          },
        },
      })
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rooms",
          filter: `id=eq.${room.id}`,
        },
        (p) => {
          lastEventAtRef.current = Date.now();
          if (p.new) {
            const nr = p.new as unknown as Room;
            setRoom(nr);
            // Relay: anuncia para os outros clientes a nova assinatura
            // (status, round). Quem não recebeu o postgres_changes via DB
            // ainda assim escuta esse broadcast e se cura sozinho.
            const sig = `${nr.status}|${nr.current_round}|${nr.current_word_id ?? ""}`;
            if (sig !== lastRoomSigRef.current) {
              lastRoomSigRef.current = sig;
              ch.send({
                type: "broadcast",
                event: "room-sync",
                payload: { sig, ts: Date.now() },
              }).catch(() => {});
            }
          }
        },
      )
      .on("broadcast", { event: "room-sync" }, ({ payload }) => {
        lastEventAtRef.current = Date.now();
        const sig = (payload as { sig?: string })?.sig;
        if (!sig || sig === lastRoomSigRef.current) return;
        // Recebi um sinal de fase diferente do meu estado local — perdi um
        // evento de DB. Recarrega para alinhar imediatamente, sem esperar
        // o polling.
        lastRoomSigRef.current = sig;
        reloadRef.current?.();
      })
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players",
          filter: `room_id=eq.${room.id}`,
        },
        (p) => {
          lastEventAtRef.current = Date.now();
          setPlayers((cur) => {
            if (p.eventType === "DELETE")
              return cur.filter((x) => x.id !== (p.old as Player).id);
            const incoming = p.new as Player;
            if (incoming.kicked_at)
              return cur.filter((x) => x.id !== incoming.id);
            const idx = cur.findIndex((x) => x.id === incoming.id);
            if (idx === -1) return [...cur, incoming];
            const copy = [...cur];
            copy[idx] = incoming;
            return copy;
          });
        },
      )
      // NOTA (Fase 1/S1): `definitions` saiu da publication realtime — a
      // verdade vazava no payload dos eventos. A sincronização de definições
      // agora é 100% via RPC get_round_sync (poll de fase abaixo), que o
      // servidor molda por fase: progresso sem texto na escrita, cédulas sem
      // autor na votação, tudo visível só a partir da revelação.
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "votes",
          filter: `room_id=eq.${room.id}`,
        },
        (p) => {
          lastEventAtRef.current = Date.now();
          setVotes((cur) => {
            if (p.eventType === "DELETE")
              return cur.filter((x) => x.id !== (p.old as Vote).id);
            const incoming = p.new as Vote;
            // Mesmo padrão: dropa o voto "pending_" otimista do mesmo
            // votante/rodada quando o real chega via realtime.
            const cleaned = cur.filter(
              (x) =>
                !(
                  x.id.startsWith("pending_") &&
                  x.voter_id === incoming.voter_id &&
                  x.round === incoming.round
                ),
            );
            const idx = cleaned.findIndex((x) => x.id === incoming.id);
            if (idx === -1) return [...cleaned, incoming];
            const copy = [...cleaned];
            copy[idx] = incoming;
            return copy;
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "round_extensions",
          filter: `room_id=eq.${room.id}`,
        },
        (p) => {
          lastEventAtRef.current = Date.now();
          const ext = p.new as RoundExtension;
          setRoundExtensions((cur) =>
            cur.some((x) => x.id === ext.id) ? cur : [...cur, ext],
          );
          const player = playersRef.current.find((x) => x.id === ext.player_id);
          if (!player || player.is_bot) return;
          const currentRoom = roomRef.current;
          const isMe = ext.player_id === playerId;
          const name = isMe ? "Você" : player.nickname;
          const verbo = isMe ? "perdeu" : "perdeu";
          const eliminated = ext.attempt >= 3;
          if (eliminated) {
            toast.error(
              `${name} ${verbo} 1 ponto e foi eliminado(a) da partida ⛔`,
              { duration: 5000 },
            );
          } else if (
            currentRoom?.status === "writing" &&
            currentRoom.current_round === ext.round
          ) {
            const seconds = ext.attempt === 1 ? 20 : 15;
            toast(
              `⏰ ${name} ${verbo} 1 ponto. ${ext.attempt === 1 ? `Nova oportunidade: +${seconds}s para enviar.` : `Última chance: +${seconds}s para enviar.`}`,
              {
                duration: 5500,
              },
            );
          } else {
            const restantes = 3 - ext.attempt;
            toast(
              `⏰ ${name} ${verbo} 1 ponto por estourar o tempo. ${restantes === 1 ? "Última chance!" : `Faltam ${restantes} chances.`}`,
              {
                duration: 4500,
              },
            );
          }
        },
      )
      .on("presence", { event: "sync" }, () => {
        const state = ch.presenceState() as Record<
          string,
          Array<{ player_id?: string }>
        >;
        const connected: Record<string, boolean> = {};
        for (const key of Object.keys(state)) {
          const meta = state[key]?.[0];
          const pid = meta?.player_id || key;
          connected[pid] = true;
        }
        setPresenceMap(connected);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED" && playerId) {
          await ch.track({
            player_id: playerId,
            online_at: new Date().toISOString(),
          });
          // Pode ter chegado depois de uma queda — recarrega para fechar a
          // janela em que eventos foram perdidos enquanto o canal estava off.
          // Otimização: se o snapshot inicial acabou de carregar (<3s),
          // pula o reload duplicado para economizar uma RPC `get_room_state`.
          if (Date.now() - lastEventAtRef.current > 3000) {
            reloadRef.current?.();
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          // Supabase já tenta reconectar sozinho; ao voltar ao SUBSCRIBED o
          // ramo acima dispara o reload. Aqui só logamos para diagnóstico.
          console.warn(
            "[realtime] channel status:",
            status,
            "— aguardando reconexão",
          );
        }
      });
    return () => {
      supabase.removeChannel(ch);
    };
  }, [room?.id, playerId]);

  // Optimistic player adds (e.g. addBot) — adiciona localmente sem esperar
  // o echo de realtime. Quando o evento postgres_changes chegar, o reducer
  // acima faz merge por id (substitui in-place).
  useEffect(() => {
    if (!room?.id) return;
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        { roomId?: string; player?: Player } | undefined;
      if (!detail?.player || detail.roomId !== room.id) return;
      optimisticPlayerIdsRef.current[detail.player.id] = Date.now();
      setPlayers((cur) =>
        cur.some((p) => p.id === detail.player!.id)
          ? cur
          : [...cur, detail.player!],
      );
    };
    const onRemove = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        { playerId?: string } | undefined;
      if (!detail?.playerId) return;
      delete optimisticPlayerIdsRef.current[detail.playerId];
      setPlayers((cur) => cur.filter((p) => p.id !== detail.playerId));
    };
    const onDefAdd = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        { roomId?: string; definition?: Definition } | undefined;
      if (!detail?.definition || detail.roomId !== room.id) return;
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
        { roomId?: string; vote?: Vote } | undefined;
      if (!detail?.vote || detail.roomId !== room.id) return;
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
        detail.roomId !== room.id ||
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
        { roomId?: string; pendingId?: string } | undefined;
      if (!detail?.pendingId || detail.roomId !== room.id) return;
      setDefinitions((cur) => cur.filter((d) => d.id !== detail.pendingId));
    };
    const onVoteRollback = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        { roomId?: string; pendingId?: string } | undefined;
      if (!detail?.pendingId || detail.roomId !== room.id) return;
      setVotes((cur) => cur.filter((v) => v.id !== detail.pendingId));
    };
    const onRoomUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        { roomId?: string; patch?: Partial<Room> } | undefined;
      if (!detail?.patch || detail.roomId !== room.id) return;
      setRoom((cur) => (cur ? ({ ...cur, ...detail.patch } as Room) : cur));
    };
    const onPlayerUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        { playerId?: string; patch?: Partial<Player> } | undefined;
      if (!detail?.playerId || !detail.patch) return;
      setPlayers((cur) =>
        cur.map((p) =>
          p.id === detail.playerId ? ({ ...p, ...detail.patch } as Player) : p,
        ),
      );
    };
    const onPlayersClearTeam = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        { roomId?: string } | undefined;
      if (detail?.roomId !== room.id) return;
      setPlayers((cur) => cur.map((p) => ({ ...p, team_id: null })));
    };
    window.addEventListener("player:optimistic-add", onAdd as EventListener);
    window.addEventListener(
      "player:optimistic-remove",
      onRemove as EventListener,
    );
    window.addEventListener(
      "player:optimistic-update",
      onPlayerUpdate as EventListener,
    );
    window.addEventListener(
      "players:optimistic-clear-team",
      onPlayersClearTeam as EventListener,
    );
    window.addEventListener(
      "room:optimistic-update",
      onRoomUpdate as EventListener,
    );
    window.addEventListener(
      "definition:optimistic-add",
      onDefAdd as EventListener,
    );
    window.addEventListener(
      "definitions:optimistic-replace-round",
      onDefsReplaceRound as EventListener,
    );
    window.addEventListener("vote:optimistic-add", onVoteAdd as EventListener);
    window.addEventListener(
      "definition:optimistic-rollback",
      onDefRollback as EventListener,
    );
    window.addEventListener(
      "vote:optimistic-rollback",
      onVoteRollback as EventListener,
    );
    return () => {
      window.removeEventListener(
        "player:optimistic-add",
        onAdd as EventListener,
      );
      window.removeEventListener(
        "player:optimistic-remove",
        onRemove as EventListener,
      );
      window.removeEventListener(
        "player:optimistic-update",
        onPlayerUpdate as EventListener,
      );
      window.removeEventListener(
        "players:optimistic-clear-team",
        onPlayersClearTeam as EventListener,
      );
      window.removeEventListener(
        "room:optimistic-update",
        onRoomUpdate as EventListener,
      );
      window.removeEventListener(
        "definition:optimistic-add",
        onDefAdd as EventListener,
      );
      window.removeEventListener(
        "definitions:optimistic-replace-round",
        onDefsReplaceRound as EventListener,
      );
      window.removeEventListener(
        "vote:optimistic-add",
        onVoteAdd as EventListener,
      );
      window.removeEventListener(
        "definition:optimistic-rollback",
        onDefRollback as EventListener,
      );
      window.removeEventListener(
        "vote:optimistic-rollback",
        onVoteRollback as EventListener,
      );
    };
  }, [room?.id]);

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
      const { data: sync } = await (supabase.rpc as any)("get_round_sync", {
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
      const { data: sync, error: syncErr } = await (supabase.rpc as any)(
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
    const onResume = () => {
      if (document.visibilityState !== "visible") return;
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
