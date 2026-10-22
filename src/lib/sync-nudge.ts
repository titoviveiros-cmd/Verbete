// Aviso leve "há estado novo, releia do servidor" (playtest 2026-10-22).
// As definições não passam pelo realtime (S1: o payload vazava a verdade),
// então o contador "X/Y enviaram" dos outros aparelhos dependia do poll de
// get_round_sync (1,2 s na escrita) — 1 a 2,5 s de atraso percebido. Agora
// quem teve a AÇÃO confirmada (definição, voto, bots) avisa o canal da sala
// e os outros releem na hora. O aviso nasce de um commit, nunca de uma
// leitura (sem laço poll → aviso → poll) e não leva texto, autor, verdade
// nem significado: só sala, rodada, tipo e versão. Os polls continuam como
// rede de segurança.
export type NudgeKind = "definition" | "bot_definitions" | "vote" | "bot_votes";
export const NUDGE_EVENT = "round:sync-nudge";
export const NUDGE_BROADCAST = "round-sync-needed";

export type NudgePayload = {
  room_id: string;
  round: number;
  kind: NudgeKind;
  v: number;
};

/** Ação confirmada pelo servidor: avisa a sala (via o canal realtime). */
export function nudgeRoundSync(roomId: string, round: number, kind: NudgeKind) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(NUDGE_EVENT, { detail: { roomId, round, kind } }),
  );
}

/** Payload mínimo do aviso — nada protegido pela arquitetura S1/S2. */
export function nudgePayload(
  roomId: string,
  round: number,
  kind: NudgeKind,
  now = Date.now(),
): NudgePayload {
  return { room_id: roomId, round, kind, v: now };
}

/** Junta avisos que chegam juntos numa leitura só (janela curta). */
export function createCoalescer(fn: () => void, ms = 100) {
  let t: ReturnType<typeof setTimeout> | null = null;
  const trigger = () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
  trigger.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  return trigger;
}

/** Respostas fora de ordem: só vale a de um pedido mais novo que o último
 *  aplicado (um poll lento não desfaz o que um aviso já trouxe). */
export function createLatestGate() {
  let issued = 0;
  let applied = 0;
  return {
    next: () => ++issued,
    accept: (seq: number) => {
      if (seq < applied) return false;
      applied = seq;
      return true;
    },
  };
}
