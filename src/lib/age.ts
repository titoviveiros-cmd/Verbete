// Faixa etária — ECA Digital (Lei 15.211/2025), proposta B5 (11/11/2026).
//
// (a) OBRIGAÇÃO EXPRESSA: "informar extensivamente a todos os usuários sobre
//     a faixa etária indicada" (art. 8º V); estar apto a receber o sinal de
//     idade das lojas (art. 14 caput) e ter mecanismos próprios (art. 14 p.ú.).
// (b) INTERPRETAÇÃO (confiança moderada): sem conteúdo impróprio a menores,
//     a verificação "vedada a autodeclaração" do art. 9º §1º não incide, e uma
//     autodeclaração neutra serve como mecanismo próprio PROPORCIONAL
//     (D12880 art. 24, I). Depende do parecer (Q6).
// (c) PRODUTO: ano de nascimento guardado SÓ NO APARELHO (não vai ao
//     servidor); menor de 13 joga só com bots.
//
// ⚠️ AUTODECLARAÇÃO NÃO É COMPROVAÇÃO JURÍDICA DE IDADE. Este módulo não
// verifica idade, não colhe consentimento dos pais e não deve ser citado
// como se fizesse isso. Ele só aplica a experiência mais protetiva para a
// faixa que a pessoa DECLAROU (ou que o sinal da loja indicar, o que for
// mais protetivo — ver age-signals.ts).
import { getStored, setStored } from "@/lib/player-id";
import { AGE_STORAGE_KEY, type AgeDeclaration } from "@/lib/age-record";

export { AGE_STORAGE_KEY, type AgeDeclaration } from "@/lib/age-record";

export const AGE_RATING = 13;
export const AGE_RATING_LABEL = "13+";

export type AgeBand = "under13" | "teen" | "adult" | "unknown";

/** Ordem do mais protetivo para o menos protetivo. */
const PROTECTION_ORDER: AgeBand[] = ["under13", "unknown", "teen", "adult"];

export const AGE_SELF_DECLARATION_NOTICE =
  "Isto é uma autodeclaração: não comprova sua idade e não substitui a autorização dos seus pais ou responsáveis. Fica só neste aparelho.";

/**
 * Faixa pelo ano de nascimento. Sem mês/dia, usa a idade MÍNIMA possível
 * (quem ainda não fez aniversário no ano) — o lado mais protetivo.
 */
export function ageBandFromBirthYear(
  birthYear: number,
  now: Date = new Date(),
): AgeBand {
  const year = now.getFullYear();
  if (
    !Number.isInteger(birthYear) ||
    birthYear < year - 120 ||
    birthYear > year
  )
    return "unknown";
  const minAge = year - birthYear - 1;
  if (minAge < AGE_RATING) return "under13";
  if (minAge < 18) return "teen";
  return "adult";
}

/** A faixa mais protetiva entre as informadas (declaração, sinal da loja). */
export function mostProtective(...bands: Array<AgeBand | null>): AgeBand {
  const known = bands.filter((b): b is AgeBand => b !== null);
  if (known.length === 0) return "unknown";
  return known.reduce((a, b) =>
    PROTECTION_ORDER.indexOf(a) <= PROTECTION_ORDER.indexOf(b) ? a : b,
  );
}

/** Menor de 13: só bots (sem interação com outras pessoas). */
export function botsOnly(band: AgeBand): boolean {
  return band === "under13";
}

export function readAgeDeclaration(): AgeDeclaration | null {
  const d = getStored<AgeDeclaration | null>(AGE_STORAGE_KEY, null);
  return d && Number.isInteger(d.birthYear) ? d : null;
}

/** Evento disparado quando a pessoa declara (telas abertas se atualizam). */
export const AGE_DECLARED_EVENT = "age:declared";

export function saveAgeDeclaration(birthYear: number, now = new Date()) {
  setStored<AgeDeclaration>(AGE_STORAGE_KEY, {
    birthYear,
    at: now.toISOString(),
  });
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(AGE_DECLARED_EVENT));
}

/** Faixa declarada neste aparelho ("unknown" se ainda não declarou). */
export function declaredAgeBand(now = new Date()): AgeBand {
  const d = readAgeDeclaration();
  return d ? ageBandFromBirthYear(d.birthYear, now) : "unknown";
}

/** Anos oferecidos no seletor (do mais recente ao mais antigo, 100 anos). */
export function birthYearOptions(now = new Date()): number[] {
  const y = now.getFullYear();
  return Array.from({ length: 101 }, (_, i) => y - i);
}
