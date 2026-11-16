// Acesso à sala — ECA Digital (Lei 15.211/2025, art. 21 p.ú.; Lei 14.852/2024
// art. 16 VII), proposta B4 (11/11/2026).
//
// (a) OBRIGAÇÃO EXPRESSA: limitar a interação POR PADRÃO e permitir
//     desativá-la (L14852 art. 16 VII).
// (b) INTERPRETAÇÃO (confiança moderada): "por padrão" = a sala só se acha
//     pelo código ou link de convite; o dono pode trancar; partida rápida com
//     desconhecidos fechada. Se isso basta sem consentimento dos pais é
//     pergunta do parecer (Q2) — nada aqui finge colher consentimento.
// (c) PRODUTO: "Jogar só com bots" = trancar a sala + completar com bots.
//
// O servidor é quem garante (migration 20261111140000: rooms.locked,
// set_room_locked e o gatilho players_room_access_guard); aqui só a chamada,
// o otimismo da tela e a regra de quando a partida rápida PODERIA aparecer.
import { supabase } from "@/integrations/supabase/client";
import { addBot } from "@/lib/room";

/** Faixa etária que o app conhece (autodeclarada no aparelho; ver B5). */
export type AgeBand = "under13" | "teen" | "adult" | "unknown";

/**
 * Partida rápida (sala pública com desconhecidos) só poderia aparecer para
 * quem declarou 18+ E escolheu explicitamente. Hoje está FECHADA no servidor
 * (public_rooms_open() = false) e sem botão no app; esta regra é o portão do
 * app para quando houver decisão (parecer). Autodeclaração não comprova idade.
 */
export function publicMatchAllowed(input: {
  ageBand: AgeBand;
  explicitOptIn: boolean;
  serverOpen: boolean;
}): boolean {
  return (
    input.serverOpen &&
    input.ageBand === "adult" &&
    input.explicitOptIn === true
  );
}

/** Texto curto de privacidade da sala (o que o dono vê no lobby). */
export function roomPrivacyLabel(locked: boolean): string {
  return locked
    ? "🔒 Sala trancada — ninguém novo entra."
    : "🔐 Sala privada — só entra quem tem o código ou o link.";
}

export class RoomLockError extends Error {}

function patchRoom(roomId: string, patch: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("room:optimistic-update", { detail: { roomId, patch } }),
  );
}

/** Dono tranca/destranca a sala. Desfaz o otimismo se o servidor recusar. */
export async function setRoomLocked(
  roomId: string,
  actorId: string,
  locked: boolean,
): Promise<void> {
  patchRoom(roomId, { locked });
  const { data, error } = await supabase.rpc("set_room_locked", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_locked: locked,
  });
  const res = data as { ok?: boolean; reason?: string } | null;
  if (error || !res?.ok) {
    patchRoom(roomId, { locked: !locked });
    throw new RoomLockError(
      res?.reason === "not_host"
        ? "Só quem criou a sala pode trancar."
        : "Não deu para trancar a sala agora. Tente de novo.",
    );
  }
}

/**
 * "Jogar só com bots": tranca a sala (ninguém novo entra) e completa a mesa
 * com bots até o mínimo. Desliga a interação com outras pessoas
 * (L14852 art. 16 VII) sem sair do jogo.
 */
export async function playOnlyWithBots(
  roomId: string,
  actorId: string,
  currentPlayers: number,
  botsNeeded: number,
): Promise<void> {
  await setRoomLocked(roomId, actorId, true);
  for (let i = 0; i < botsNeeded; i++)
    await addBot(roomId, actorId, currentPlayers + i);
}
