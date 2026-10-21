import { supabase } from "@/integrations/supabase/client";

// Presença para a PAUSA de partida (playtest 2026-10-21): o servidor só
// pausa a escrita/votação quando nenhum humano da mesa está presente —
// "presente" = tocou no app no último minuto e não saiu da tela depois.
// 'active' vai no toque (no máx. 1×/ACTIVE_THROTTLE_MS) e quando o app volta
// à tela; 'away' vai quando o app sai da tela (bloqueio, troca de app).
export const ACTIVE_THROTTLE_MS = 15_000;

export type PresenceState = "active" | "away";

export async function touchPresence(
  roomId: string,
  playerId: string,
  state: PresenceState,
) {
  const { data, error } = await supabase.rpc("touch_presence", {
    p_room_id: roomId,
    p_player_id: playerId,
    p_state: state,
  });
  if (error) return { ok: false as const, resumed: false };
  const res = (data ?? {}) as { ok?: boolean; resumed?: boolean };
  return { ok: !!res.ok, resumed: !!res.resumed };
}

/** 'away' ao sair da tela: fetch com keepalive (sobrevive ao fechamento da
 *  aba/bloqueio do celular) e o token da sessão já em mãos — sem await. */
export function sendAwayBeacon(
  roomId: string,
  playerId: string,
  accessToken: string | null,
) {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as
    string | undefined;
  if (!url || !key || !accessToken || typeof fetch === "undefined") return;
  try {
    void fetch(`${url}/rest/v1/rpc/touch_presence`, {
      method: "POST",
      keepalive: true,
      headers: {
        apikey: key,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_room_id: roomId,
        p_player_id: playerId,
        p_state: "away",
      }),
    }).catch(() => {});
  } catch {
    // melhor esforço: sem o 'away', o servidor percebe pela janela de 1 min
  }
}

export async function resumeRoom(roomId: string, playerId: string) {
  const { data, error } = await supabase.rpc("resume_room", {
    p_room_id: roomId,
    p_player_id: playerId,
  });
  if (error) throw error;
  return (data ?? {}) as { ok?: boolean; resumed?: boolean; reason?: string };
}
