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

// ---------------------------------------------------------------------------
// v2 (bot-definitions-v2, playtest 2026-10-20): bots não repetem definição na
// PARTIDA e não chegam perto da verdade. Funções puras, usadas só pela v2 —
// a v1 (em produção) segue exatamente como está.

/** Parecida demais com algo que um bot já disse NESTA partida. */
export const MATCH_REPEAT_THRESHOLD = 0.5;
/** Duas candidatas parecidas entre si: fica só a primeira. */
export const SELF_SIMILAR_THRESHOLD = 0.6;
/**
 * Corte do gate semântico dos BOTS, com o MESMO juiz e a MESMA rubrica do
 * bônus 🧠 (semantic.ts, limiar humano 80 intocado). A partir de 50 a rubrica
 * já chama de "relacionado ao significado": o bot recusa com 30 pontos de
 * folga, porque na revelação o juiz avalia a rodada inteira junta e a nota
 * pode oscilar.
 */
export const BOT_GATE_MAX_SCORE = 50;

/** Tira candidatas iguais/parecidas com definições de bot já usadas na partida. */
export function dropMatchRepeats(defs: string[], previous: string[]) {
  const prev = previous.map(normTxt).filter((p) => p.length > 0);
  const kept = defs.filter((d) => {
    const n = normTxt(d);
    return !prev.some((p) => p === n || dice(p, n) > MATCH_REPEAT_THRESHOLD);
  });
  return { kept, dropped: defs.length - kept.length };
}

/** Dedup entre as próprias candidatas (mantém a ordem; fica a primeira). */
export function dropSelfSimilar(defs: string[]) {
  const kept: string[] = [];
  for (const d of defs) {
    const n = normTxt(d);
    if (!n) continue;
    if (kept.some((k) => normTxt(k) === n || dice(k, n) > SELF_SIMILAR_THRESHOLD)) continue;
    kept.push(d);
  }
  return { kept, dropped: defs.length - kept.length };
}

/**
 * Gate semântico: fica só quem o juiz NOTOU e com nota abaixo do corte.
 * Candidata sem nota (o juiz pulou) não entra — na dúvida, reserva.
 */
export function gateByScores(
  items: ReadonlyArray<{ id: string; text: string }>,
  scores: ReadonlyMap<string, number>,
  maxScore = BOT_GATE_MAX_SCORE,
) {
  const kept = items.filter((it) => {
    const s = scores.get(it.id);
    return s !== undefined && s < maxScore;
  });
  return { kept, dropped: items.length - kept.length };
}

/** Lista curta do que a partida já usou, para o prompt evitar de saída. */
export function avoidList(previous: string[], max = 15): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...previous].reverse()) {
    const n = normTxt(p);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(p.trim().slice(0, 140));
    if (out.length >= max) break;
  }
  return out;
}

