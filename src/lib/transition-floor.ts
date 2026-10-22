// Tempo mínimo das telas narrativas (playtest 2026-10-22): o PROCESSAMENTO
// pode terminar cedo; a TRANSIÇÃO VISUAL não some cedo. Cada piso conta a
// partir do momento em que este aparelho recebeu a informação autoritativa
// e é um piso, não uma soma: backend mais lento que o piso não ganha espera.
export const NARRATIVE_MIN_VISIBLE_MS = 2500;

/** Quando o host (ou quem cobre a falta dele) abre o embaralhamento depois de
 *  todos escreverem: só bots escrevendo terminava ~3 s depois da cortina e a
 *  tela do coordenador mal aparecia. */
export function shuffleAdvanceDelayMs(
  isHost: boolean,
  writingSeenAt: number,
  now: number,
  curtainTotalMs: number,
): number {
  const base = isHost ? 600 : 1800;
  const floor = writingSeenAt + curtainTotalMs + NARRATIVE_MIN_VISIBLE_MS - now;
  return Math.max(base, floor + (isHost ? 0 : 1200));
}

type PhaseRoom = {
  status: string;
  current_round: number;
  current_word_id?: string | null;
};
/** Assinatura de fase da sala: status|rodada|palavra. */
export function roomPhaseSig(r: PhaseRoom): string {
  return `${r.status}|${r.current_round}|${r.current_word_id ?? ""}`;
}

// Virada de fase otimista mais recente deste aparelho e a fase que o servidor
// tinha ANTES dela. Uma leitura que saiu antes do commit (poll, recarga,
// eco do realtime) ainda traz essa fase antiga e desfazia a virada — no host:
// "Hora de Inventar" → "Escolha da Palavra" → "Hora de Inventar".
let lastRoomOptimisticAt = 0;
let optimisticFromSig: string | null = null;
export function markRoomOptimistic(fromSig: string | null, now = Date.now()) {
  lastRoomOptimisticAt = now;
  optimisticFromSig = fromSig;
}
/** O servidor recusou a virada (ex.: a escolha da palavra falhou): a próxima
 *  leitura vale de novo, sem esperar a janela. */
export function clearRoomOptimistic() {
  lastRoomOptimisticAt = 0;
  optimisticFromSig = null;
}
/** Janela em que a fase local, à frente do servidor, não é desfeita. */
export const OPTIMISTIC_GRACE_MS = 6000;
/** Leitura do servidor com a fase de ANTES da virada otimista recente: saiu
 *  antes do commit e não volta a tela. Só essa fase é ignorada — outra fase
 *  (outro aparelho escolheu primeiro, a sala avançou) vale na hora. */
export function isStaleServerPhase(server: PhaseRoom, now = Date.now()) {
  return (
    now - lastRoomOptimisticAt < OPTIMISTIC_GRACE_MS &&
    optimisticFromSig !== null &&
    roomPhaseSig(server) === optimisticFromSig
  );
}

/** A leitura voltaria a tela local (à frente) para a fase de antes da
 *  virada otimista recente. Tela já na fase do servidor: nada a proteger. */
export function keepsLocalPhase(
  cur: PhaseRoom,
  server: PhaseRoom,
  now = Date.now(),
) {
  return (
    isStaleServerPhase(server, now) &&
    roomPhaseSig(cur) !== roomPhaseSig(server)
  );
}

type PolledRoom = PhaseRoom & {
  round_phase_ends_at?: string | null;
  current_coordinator?: string | null;
  host_id?: string | null;
  paused_at?: string | null;
};
/** Leitura periódica com a MESMA assinatura de fase que o servidor já tinha
 *  mandado: só regrava a sala se algo mudou (sem mudança, devolve o mesmo
 *  objeto — sem re-render) e nunca com a fase de antes de uma virada
 *  otimista recente. */
export function mergeSamePhasePoll<T extends PolledRoom>(
  cur: T,
  data: PolledRoom,
  now = Date.now(),
): T {
  if (keepsLocalPhase(cur, data, now)) return cur;
  return roomPhaseSig(cur) !== roomPhaseSig(data) ||
    cur.round_phase_ends_at !== data.round_phase_ends_at ||
    cur.current_coordinator !== data.current_coordinator ||
    cur.host_id !== data.host_id ||
    (cur.paused_at ?? null) !== (data.paused_at ?? null)
    ? ({ ...cur, ...data } as T)
    : cur;
}
