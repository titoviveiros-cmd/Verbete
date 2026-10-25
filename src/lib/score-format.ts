// Linhas de pontuação do placar (Android 2026-10-25): descrição e valor
// separados, para o valor ("+3 pts") ser uma unidade que nunca quebra.

export type ScoreReason = {
  /** Ícone + descrição ("🧠 Chegou perto da verdade 1×"); pode quebrar. */
  label: string;
  /** Pontos da linha; ausente = linha só de texto. */
  points?: number;
  /** Bônus 🧠 de proximidade (destaque próprio, ≠ acertar a verdade). */
  near?: boolean;
};

/** "+1 pt", "+3 pts", "-1 pt" — singular só para 1. */
export function formatPoints(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${abs} ${abs === 1 ? "pt" : "pts"}`;
}
