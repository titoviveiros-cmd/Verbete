// Ponto de integração do SINAL DE IDADE da Google Play (Age Signals API) —
// ECA Digital art. 14 caput: o fornecedor deve estar apto a RECEBER a
// informação de idade que lojas e sistemas operacionais fornecem (art. 12).
// Proposta B5 (11/11/2026).
//
// DESLIGADO POR PADRÃO. Estado da API (lido em 11/11/2026,
// developer.android.com/google/play/age-signals): beta, biblioteca 0.0.4,
// devolve ageLower/ageUpper (faixas 0–12, 13–15, 16–17, 18+) e a origem do
// dado; a doc da versão anterior diz que no Brasil o status vem só como
// "declarado"/"desconhecido" (sem aprovação parental). Os termos da API só
// permitem usar o sinal para experiência adequada à idade — NUNCA anúncio,
// perfilamento ou analytics.
//
// Para ligar (decisão do dono + parecer): instalar um plugin Capacitor que
// chame a biblioteca Play Age Signals no Android, implementar `requestSignal`
// abaixo e trocar AGE_SIGNALS_ENABLED. O app usa sempre o MAIS PROTETIVO
// entre o sinal e a autodeclaração (age.ts → mostProtective). O sinal não é
// guardado no servidor.
import type { AgeBand } from "@/lib/age";

export const AGE_SIGNALS_ENABLED = false;

export type PlayAgeSignal = {
  /** Limite inferior/superior da faixa (anos), null quando a loja não sabe. */
  ageLower: number | null;
  ageUpper: number | null;
  /** Origem informada pela loja (declarado pela pessoa, verificado etc.). */
  source: "declared" | "verified" | "supervised" | "unknown";
};

/** Faixa do app a partir do sinal da loja (null = sem sinal útil). */
export function ageBandFromSignal(s: PlayAgeSignal | null): AgeBand | null {
  if (!s || (s.ageUpper === null && s.ageLower === null)) return null;
  // Usa o limite INFERIOR (mais protetivo); sem ele, o superior.
  const age = s.ageLower ?? s.ageUpper!;
  if (age < 13) return "under13";
  if (age < 18) return "teen";
  return "adult";
}

/** Implementação nativa (plugin) — ainda não existe. */
type Requester = () => Promise<PlayAgeSignal | null>;
let requestSignal: Requester | null = null;

/** Para o plugin nativo (e testes) registrarem a chamada real. */
export function registerAgeSignalRequester(fn: Requester | null) {
  requestSignal = fn;
}

/**
 * Sinal de idade da Play, ou null (desligado, sem plugin, fora do Android ou
 * erro). Nunca lança: a ausência do sinal não pode travar o jogo.
 */
export async function getPlayAgeSignal(
  enabled: boolean = AGE_SIGNALS_ENABLED,
): Promise<PlayAgeSignal | null> {
  if (!enabled || !requestSignal) return null;
  try {
    return await requestSignal();
  } catch {
    return null;
  }
}
