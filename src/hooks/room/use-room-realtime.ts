// Módulo: canal realtime da sala — postgres_changes (rooms/players/votes/
// round_extensions), broadcast `room-sync` (peers curam peers), presence
// (quem está online) e telemetria de quedas de canal (Fase 8).
import { useEffect } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Room, Player, Vote } from "@/lib/room";
import type { RoundExtension } from "@/hooks/use-room";
import { reportOpsEvent } from "@/lib/ops";
import type { RoomCtx } from "./ctx";

export function useRoomRealtime(ctx: RoomCtx) {
  const {
    room,
    playerId,
    setRoom,
    setPlayers,
    setVotes,
    setRoundExtensions,
    setPresenceMap,
    lastEventAtRef,
    lastRoomSigRef,
    reloadRef,
    playersRef,
    roomRef,
  } = ctx;
  const roomId = room?.id;

  useEffect(() => {
    if (!roomId) return;
    const ch = supabase
      .channel(`room:${roomId}`, {
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
          filter: `id=eq.${roomId}`,
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
          filter: `room_id=eq.${roomId}`,
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
      // agora é 100% via RPC get_round_sync (módulo de polling), que o
      // servidor molda por fase: progresso sem texto na escrita, cédulas sem
      // autor na votação, tudo visível só a partir da revelação.
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "votes",
          filter: `room_id=eq.${roomId}`,
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
          filter: `room_id=eq.${roomId}`,
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
          // Fase 8: quedas de canal viram métrica (com throttle/dedupe no ops)
          reportOpsEvent("reconnect", { channel_status: status });
        }
      });
    return () => {
      supabase.removeChannel(ch);
    };
    // setters/refs são estáveis; deps idênticas ao monólito original
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, playerId]);
}
