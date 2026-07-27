// Módulo: polling e recuperação de conexão — as redes de segurança que
// mantêm todos os clients na mesma fase mesmo com realtime falho:
// 1. reload ao focar a aba com canal silencioso (>5s)
// 2. poll de fase (get_round_sync) — fonte única de definições/votos (S1)
// 3. reload adaptativo (canal mudo >25s)
// 4. poll rápido da assinatura da sala (~2,5s) + reconciliação de jogadores
// 5. offline/online do navegador (ConnectionState)
// 6. retomada da aba no mobile (iOS congela timers; >15min = reload duro)
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Room, Player, Definition, Vote } from "@/lib/room";
import type { RoundExtension } from "@/hooks/use-room";
import type { RoomCtx } from "./ctx";

export function useRoomPolling(ctx: RoomCtx) {
  const {
    code,
    room,
    setRoom,
    setPlayers,
    setDefinitions,
    setVotes,
    setRoundExtensions,
    setDegraded,
    reloadRef,
    optimisticPlayerIdsRef,
    lastEventAtRef,
    lastRoomSigRef,
  } = ctx;
  const roomId = room?.id;
  const roomStatus = room?.status;
  const roomRound = room?.current_round;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Fonte única de definições/votos durante as fases ativas: a RPC
  // get_round_sync devolve o shape que o servidor permite para a fase
  // (S1: sem texto na escrita, sem autor na votação, completo no reveal).
  useEffect(() => {
    if (!roomId || !roomStatus) return;
    if (!["writing", "shuffling", "voting", "reveal"].includes(roomStatus))
      return;
    let cancelled = false;
    const refreshRound = async () => {
      const { data: sync, error: syncErr } = await supabase.rpc(
        "get_round_sync",
        { p_room_id: roomId },
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
    const interval = roomStatus === "writing" ? 1200 : 700;
    const t = window.setInterval(refreshRound, interval);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, roomRound, roomStatus]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Poll RÁPIDO da assinatura da sala (status|round|word). É uma query
  // mínima (1 linha, 4 colunas) que dispara em ~2,5s e detecta qualquer
  // divergência local — fechando o gap quando o cliente perde um
  // postgres_changes E o broadcast `room-sync` dos peers (ex: aba que
  // estava em background e voltou, queda momentânea de WS, conexão lenta).
  // Sem isso, jogadores podiam ficar até 25s atrasados em relação ao host.
  useEffect(() => {
    if (!roomId) return;
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
          const dbPlayers = ps as unknown as Player[];
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
