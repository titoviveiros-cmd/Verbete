// Motivos da denúncia de jogador — módulo sem zod, seguro para o bundle do
// cliente (modal da sala e painel /admin/reports). A gravação fica em
// report-player.ts (só servidor).
export const PLAYER_REPORT_REASONS = {
  nickname: "Apelido ofensivo ou impróprio",
  behavior: "Assédio, ameaça ou ofensa pessoal",
  impersonation: "Se passa por outra pessoa",
  other: "Outro",
} as const;
export type PlayerReportReason = keyof typeof PLAYER_REPORT_REASONS;

/** Prefixo do motivo na fila de reports (diferencia de definição). */
export const PLAYER_REASON_PREFIX = "player_";

/** Denúncia de jogador (e não de definição) na fila de moderação. */
export function isPlayerReport(r: { reason: string }): boolean {
  return r.reason.startsWith(PLAYER_REASON_PREFIX);
}

/** Rótulo legível do motivo para o painel de moderação. */
export function playerReasonLabel(reason: string): string {
  const key = reason.slice(PLAYER_REASON_PREFIX.length);
  return key in PLAYER_REPORT_REASONS
    ? PLAYER_REPORT_REASONS[key as PlayerReportReason]
    : reason;
}
