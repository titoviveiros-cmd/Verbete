// Escritas de configuração da sala pelo host (lobby): modo de fim, alvo,
// nível, categorias, modo/times. Uma escrita por vez por sala, e só a
// última intenção de cada campo vale.
//
// Causa da corrida (micro-rodada pré-loja, 18/10/2026): cada toque disparava
// um `host_update_room_config` sem esperar o anterior. "Rodadas" (→ 10) e
// "5 rod." (→ 5) em sequência rápida viravam duas requisições simultâneas, e
// o banco aplica na ordem em que cada transação pega o lock da linha da sala,
// não na ordem dos toques. Se a do 10 chegava por último, a sala ficava com
// 10. E o eco do realtime de uma escrita mais antiga (o servidor grava cada
// campo num UPDATE próprio) sobrescrevia o estado otimista mais novo do host:
// a tela piscava 5 → 10 → 5.
//
// Correção (sem debounce, sem mexer no banco):
// 1. fila por sala: a próxima escrita só sai quando a anterior respondeu;
// 2. toques durante uma escrita se fundem num único patch pendente (vale o
//    último valor de cada campo), então N toques rápidos = no máximo 2 escritas;
// 3. o host mantém a própria intenção (campos escalares) por cima das linhas
//    que chegam do servidor até a fila esvaziar e o último eco das suas
//    escritas chegar — um eco por campo gravado;
// 4. escrita recusada ou com erro: a intenção é descartada e a sala recarrega
//    (a tela volta para a verdade do servidor).
// O servidor continua sendo a autoridade: só o host, só no lobby.
import type { NivelFilter, Room, RoomMode, Team } from "@/lib/room";

export type RoomConfigPatch = {
  win_condition?: "rounds" | "score";
  win_target?: number;
  nivel?: NivelFilter;
  categories?: string[];
  mode?: RoomMode;
  teams?: Team[];
};

/** Envia um patch; `true` = o servidor aplicou (`ok`). */
export type ConfigSender = (
  roomId: string,
  actorId: string,
  patch: RoomConfigPatch,
) => Promise<boolean>;

/** De onde veio a linha da sala: eco do realtime ou recarga completa. */
export type RoomRowSource = "realtime" | "snapshot";

// Só campos escalares ficam por cima: arrays (categorias, times) voltam
// saneados pelo servidor e seguem o fluxo normal.
const OVERLAY_KEYS = ["win_condition", "win_target", "nivel", "mode"] as const;
type OverlayKey = (typeof OVERLAY_KEYS)[number];

type RoomQueue = {
  actorId: string;
  /** Patch ainda não enviado (fundido). */
  queued: RoomConfigPatch | null;
  inFlight: boolean;
  /** Última intenção do host para os campos escalares. */
  intent: Partial<Record<OverlayKey, unknown>>;
  /** Ecos do realtime ainda a caminho (um por campo gravado). */
  pendingEchoes: number;
  drained: Promise<void>;
};

const defaultSender: ConfigSender = async (roomId, actorId, patch) => {
  const { supabase } = await import("@/integrations/supabase/client");
  const { data, error } = await supabase.rpc("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: patch as never,
  });
  if (error) {
    console.error("host_update_room_config failed", error);
    return false;
  }
  if ((data as { ok?: boolean } | null)?.ok === false) {
    console.error("host_update_room_config refused", data);
    return false;
  }
  return true;
};

let sender: ConfigSender = defaultSender;
const queues = new Map<string, RoomQueue>();

/** Só para testes: troca o envio e zera o estado. */
export function __resetRoomConfigWriter(custom?: ConfigSender) {
  sender = custom ?? defaultSender;
  queues.clear();
}

function settled(q: RoomQueue) {
  return !q.inFlight && !q.queued && q.pendingEchoes === 0;
}

async function pump(roomId: string, q: RoomQueue) {
  q.inFlight = true;
  try {
    while (q.queued) {
      const patch = q.queued;
      q.queued = null;
      // Conta antes de enviar: o eco pode chegar antes da resposta HTTP.
      const echoes = Object.keys(patch).length;
      q.pendingEchoes += echoes;
      let ok = false;
      try {
        ok = await sender(roomId, q.actorId, patch);
      } catch (e) {
        console.error("host_update_room_config failed", e);
      }
      if (!ok) {
        // Recusada (não é host, saiu do lobby) ou rede: nada pendente vale
        // mais. Recarrega para a tela mostrar o que o servidor tem.
        q.queued = null;
        q.intent = {};
        q.pendingEchoes = 0;
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("room:config-resync", { detail: { roomId } }),
          );
        }
        break;
      }
    }
  } finally {
    q.inFlight = false;
    // Todos os ecos já chegaram antes das respostas: nada a proteger.
    if (settled(q)) q.intent = {};
  }
}

/**
 * Enfileira um patch de configuração. Devolve uma promessa que resolve
 * quando a fila da sala esvaziar (útil para testes; a UI não espera).
 */
export function queueRoomConfig(
  roomId: string,
  actorId: string,
  patch: RoomConfigPatch,
): Promise<void> {
  let q = queues.get(roomId);
  if (!q) {
    q = {
      actorId,
      queued: null,
      inFlight: false,
      intent: {},
      pendingEchoes: 0,
      drained: Promise.resolve(),
    };
    queues.set(roomId, q);
  }
  q.actorId = actorId;
  q.queued = { ...(q.queued ?? {}), ...patch };
  for (const k of OVERLAY_KEYS) {
    if (k in patch) q.intent[k] = patch[k];
  }
  if (!q.inFlight) q.drained = pump(roomId, q);
  return q.drained;
}

/**
 * Aplica a intenção pendente do host sobre uma linha da sala vinda do
 * servidor. Ecos de escritas antigas não desfazem o último toque; quando a
 * fila esvazia e o último eco chega, vale a linha do servidor.
 */
export function withPendingConfig<T extends Room>(
  room: T,
  source: RoomRowSource = "snapshot",
): T {
  const q = queues.get(room.id);
  if (!q) return room;
  if (source === "realtime") q.pendingEchoes = Math.max(0, q.pendingEchoes - 1);
  if (Object.keys(q.intent).length === 0) return room;
  // Jogo começou ou o host mudou: a configuração do servidor é a final.
  if (room.status !== "lobby" || room.host_id !== q.actorId) {
    q.intent = {};
    q.pendingEchoes = 0;
    return room;
  }
  if (settled(q)) {
    q.intent = {};
    return room;
  }
  return { ...room, ...q.intent };
}
