// Registro da autodeclaração de idade no aparelho (ECA Digital, proposta B5).
// Sem imports com "@/": o playwright.config também lê este arquivo (como o
// terms-record.ts). Autodeclaração NÃO comprova idade — ver lib/age.ts.

/** Chave no localStorage (o prefixo "verbete:" é do getStored/setStored). */
export const AGE_STORAGE_KEY = "age-declaration";

export type AgeDeclaration = {
  birthYear: number;
  /** Quando a pessoa declarou (ISO). */
  at: string;
};

/**
 * Entrada de localStorage de um aparelho que já declarou o ano — para os
 * testes E2E partirem do jogo (como o aceite dos Termos no
 * playwright.config). O AgeGate tem teste próprio que começa do zero.
 */
export function ageDeclarationStorageEntry(
  birthYear: number,
  at = "2026-11-11T00:00:00.000Z",
): { name: string; value: string } {
  const rec: AgeDeclaration = { birthYear, at };
  return { name: "verbete:" + AGE_STORAGE_KEY, value: JSON.stringify(rec) };
}
