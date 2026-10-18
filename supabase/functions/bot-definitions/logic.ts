// Lógica pura da edge bot-definitions (sem Deno, sem rede). Coberta pelos
// testes Vitest em src/lib/__tests__/bot-definitions-logic.test.ts — inclui o
// caminho da memória por rodada, que ficou morto de 27/07 a 02/10 por um
// identificador inexistente (`norm`) e derrubava TODA geração para o
// fallback de templates.
import { parseJsonObject, type ChatResult, type OpsEvent } from "../_shared/ai.ts";

/** Minúsculas, sem acento, só [a-z0-9] separados por espaço. */
export function normTxt(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const n = ` ${normTxt(s)} `;
  const out = new Set<string>();
  for (let i = 0; i <= n.length - 3; i++) out.add(n.slice(i, i + 3));
  return out;
}

/** Coeficiente de Dice sobre trigramas do texto normalizado (0..1). */
export function dice(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/** Candidata lexicalmente próxima da verdade vaza a resposta (playtest 21/07). */
export const LEAK_THRESHOLD = 0.45;
/** Candidata parecida com algo já servido na rodada denuncia o blefe. */
export const SERVED_THRESHOLD = 0.6;

/** Definições da resposta do modelo; null quando a resposta não é utilizável. */
export function parseDefinitions(content: string, count: number): string[] | null {
  const obj = parseJsonObject(content);
  const arr = obj?.definitions;
  if (!Array.isArray(arr)) return null;
  return arr
    .filter((d): d is string => typeof d === "string")
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .slice(0, count);
}

export function dropNearTruth(defs: string[], meaning: string) {
  if (!meaning) return { kept: defs, dropped: 0 };
  const kept = defs.filter((d) => dice(d, meaning) < LEAK_THRESHOLD);
  return { kept, dropped: defs.length - kept.length };
}

export function dropAlreadyServed(defs: string[], servedNorms: string[]) {
  const kept = defs.filter((d) => {
    const n = normTxt(d);
    return !servedNorms.some((s) => s === n || dice(s, n) > SERVED_THRESHOLD);
  });
  return { kept, dropped: defs.length - kept.length };
}

/** Linhas da memória por rodada (ai_served_defs) para o que vai ser servido. */
export function servedRows(defs: string[], roomId: string, round: number) {
  return defs.map((d) => ({ room_id: roomId, round, norm_text: normTxt(d) }));
}

/**
 * Evento de operação do pedido: sucesso (>=1 definição servida), fallback
 * (modelo respondeu mas nada sobrou — o client usa templates) ou erro.
 * Só contagens e motivos: nunca palavra, verdade ou texto gerado.
 */
export function outcomeEvent(input: {
  chat: ChatResult;
  parsedCount: number | null;
  requested: number;
  returned: number;
  droppedLeak: number;
  droppedServed: number;
  latencyMs: number;
}): OpsEvent {
  const base = {
    fn: "bot-definitions",
    requested: input.requested,
    returned: input.returned,
    latency_ms: input.latencyMs,
    attempts: input.chat.attempts,
  };
  if (!input.chat.ok) {
    return {
      kind: "bot_ai_error",
      payload: { ...base, reason: input.chat.reason, ...(input.chat.status ? { status: input.chat.status } : {}) },
    };
  }
  if (input.parsedCount === null) {
    return { kind: "bot_ai_error", payload: { ...base, reason: "invalid_response" } };
  }
  if (input.returned === 0) {
    return {
      kind: "bot_ai_fallback",
      payload: {
        ...base,
        reason: input.parsedCount === 0 ? "empty" : "all_filtered",
        dropped_leak: input.droppedLeak,
        dropped_served: input.droppedServed,
      },
    };
  }
  return {
    kind: "bot_ai_success",
    payload: { ...base, dropped_leak: input.droppedLeak, dropped_served: input.droppedServed },
  };
}
