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

// ---------------------------------------------------------------------------
// FORMA do texto gerado (2026-10-24). O modelo às vezes "gagueja" — servidos
// de verdade: "min mineral de coloracao escura…", "relativo a tecido tecido
// com fios…", "em horticultura trepadeira trepadeira de…" (3 de 908 textos,
// 0,33%). Checagem barata e determinística no texto CRU do modelo, antes de
// qualquer outro filtro e da memória da rodada: texto quebrado não vira
// cédula de bot nem sugestão. CÓPIA no client (src/lib/text-filter.ts): um
// teste garante que as duas respondem igual.

/** Regras na ordem em que são checadas; devolve-se o código da 1ª violada. */
export const SHAPE_RULES = [
  "length", // R1 tamanho: 3–16 palavras e 12–120 caracteres
  "stutter", // R2 gagueira: "tecido tecido", "min mineral"
  "label", // R3 rótulo de dicionário: "(bot.) …", "s.m. …", "adj. …"
  "truncated", // R4 corte: termina em "de"/"que"/… ou em , ; : ( - ou parêntese aberto
  "junk", // R5 lixo: {}[]<>"`*#\|_ , "..", "…" ou "(3)" no fim
  "chars", // R6 caractere fora de [a-z0-9 ,.;:()'/-], token sem vogal, letra solta
  "word", // R7 a palavra da rodada (ou a raiz) no texto
] as const;
export type ShapeIssue = (typeof SHAPE_RULES)[number];

/** Listas das regras (iguais às da cópia do client — teste de igualdade). */
export const SHAPE_VOCAB = {
  /** R2: palavra funcional não conta como gagueira ("com comida", "para parede"). */
  functionWords: (
    "a o as os um uma uns umas de do da dos das em no na nos nas ao aos e ou " +
    "que se com sem por para pelo pela pelos pelas entre sobre ate como mais " +
    "muito seu sua seus suas ser ter sob num numa"
  ).split(" "),
  /** R3: rótulos de dicionário que o prompt já proíbe (pontos internos saem: "s.m." = sm). */
  labels: (
    "s sm sf adj adv v vt vi vtd vti vint vpron loc interj bot zool med min " +
    "quim geol gram fig bras pl mus anat arq fam"
  ).split(" "),
  /** R4: frase que termina nestas palavras foi cortada no meio. */
  dangling: (
    "de do da dos das em no na nos nas a o as os um uma uns umas ao aos num " +
    "numa e ou que com para por pelo pela pelos pelas cujo cuja cujos cujas onde"
  ).split(" "),
};
const FUNCTION_WORDS = new Set(SHAPE_VOCAB.functionWords);
const DICT_LABELS = new Set(SHAPE_VOCAB.labels);
const DANGLING = new Set(SHAPE_VOCAB.dangling);

/** Minúsculas, sem acento, pontuação preservada (= normalizeForGame do client). */
function gameNorm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** "(" e ")" fecham na ordem certa. */
function balancedParens(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * CÓPIA de leaksWord (src/lib/text-filter.ts) — a MESMA regra do anti-cola
 * do client: a palavra direta, sem separadores ("f.a.z.e.d.a") ou a raiz.
 */
function leaksWord(normalizedText: string, normalizedWord: string): boolean {
  if (!normalizedWord || normalizedWord.length < 3) return false;
  if (normalizedText.includes(normalizedWord)) return true;
  const letters = normalizedText.replace(/[^a-z0-9]/g, "");
  if (letters.includes(normalizedWord)) return true;
  if (normalizedWord.length >= 5) {
    const root = normalizedWord.slice(0, normalizedWord.length - 1);
    const rootRe = new RegExp(`\\b${root}\\w{0,3}\\b`);
    if (rootRe.test(normalizedText)) return true;
  }
  return false;
}

/**
 * Código da regra de forma violada (SHAPE_RULES) ou null quando o texto está
 * bem formado. `word` = palavra da rodada (R7: rejeita em vez de mascarar).
 */
export function definitionShapeIssue(text: string, word = ""): ShapeIssue | null {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  const flat = gameNorm(raw);
  const plain = normTxt(raw);
  const nWords = plain ? plain.split(" ").length : 0;
  if (nWords < 3 || nWords > 16 || plain.length < 12 || raw.length > 120) {
    return "length";
  }
  // Tokens por espaço — hífen e apóstrofo ficam dentro ("reco-reco" é 1
  // token); a pontuação das pontas sai na comparação.
  const spaced = flat.split(" ");
  const toks = spaced.map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""));
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i]!;
    const b = toks[i + 1]!;
    // o 1º termina em pontuação: não é gagueira ("mentir, mentiroso")
    if (!a || !b || /[^a-z0-9]$/.test(spaced[i]!)) continue;
    if (a === b) return "stutter";
    if (
      a.replace(/[^a-z]/g, "").length >= 3 &&
      !FUNCTION_WORDS.has(a) &&
      b.startsWith(a)
    ) {
      return "stutter";
    }
  }
  if (raw.startsWith("(") || DICT_LABELS.has((toks[0] ?? "").replace(/\./g, ""))) {
    return "label";
  }
  let last = "";
  for (let i = toks.length - 1; i >= 0 && !last; i--) last = toks[i]!;
  if (DANGLING.has(last) || /[,;:(\-–—]$/.test(raw) || !balancedParens(raw)) {
    return "truncated";
  }
  if (/[{}[\]<>"`*#\\|_]|\.\.|…/.test(raw) || /\(\s*\d+\s*\)$/.test(raw)) {
    return "junk";
  }
  if (/[^a-z0-9 ,.;:()'/-]/.test(flat)) return "chars";
  for (const t of toks) {
    if (!t) continue;
    if (!/[aeiouy0-9]/.test(t) || (t.length === 1 && !/[aeo0-9]/.test(t))) {
      return "chars";
    }
  }
  if (word && leaksWord(flat, gameNorm(word.trim()))) return "word";
  return null;
}

/** Tira as quebradas; devolve as mantidas e a contagem por regra. */
export function dropMalformed(defs: string[], word = "") {
  const kept: string[] = [];
  const byRule: Partial<Record<ShapeIssue, number>> = {};
  for (const d of defs) {
    const issue = definitionShapeIssue(d, word);
    if (issue) byRule[issue] = (byRule[issue] ?? 0) + 1;
    else kept.push(d);
  }
  return { kept, dropped: defs.length - kept.length, byRule };
}

/**
 * Campos de forma do evento: total (`dropped_shape`) e um `shape_<regra>` por
 * regra que descartou algo. Só contagens — nunca o texto.
 */
export function shapeEventFields(
  byRule: Partial<Record<ShapeIssue, number>>,
): Record<string, number> {
  let total = 0;
  const perRule: Record<string, number> = {};
  for (const r of SHAPE_RULES) {
    const n = byRule[r] ?? 0;
    if (n > 0) {
      perRule[`shape_${r}`] = n;
      total += n;
    }
  }
  return { dropped_shape: total, ...perRule };
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
  /** Descartes de FORMA por regra (dropMalformed().byRule). */
  droppedShape?: Partial<Record<ShapeIssue, number>>;
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
  const shape = shapeEventFields(input.droppedShape ?? {});
  if (input.returned === 0) {
    return {
      kind: "bot_ai_fallback",
      payload: {
        ...base,
        reason: input.parsedCount === 0 ? "empty" : "all_filtered",
        dropped_leak: input.droppedLeak,
        dropped_served: input.droppedServed,
        ...shape,
      },
    };
  }
  return {
    kind: "bot_ai_success",
    payload: {
      ...base,
      dropped_leak: input.droppedLeak,
      dropped_served: input.droppedServed,
      ...shape,
    },
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

// ---------------------------------------------------------------------------
// Geração da v2 com FORMA + filtros e no máximo UMA regeneração (2026-10-24).
// A v2 já pede candidatas a mais (EXTRA_CANDIDATES): a quebrada é trocada pela
// próxima válida. Só se, depois de forma e filtros, sobrar MENOS que `count`,
// ainda for cedo e o modelo não estiver sobrecarregado, sai UMA chamada curta
// pedindo só o que falta (+2) — antes do juiz, que continua sendo um só.
// Modelo e relógio injetados: o prazo é testável sem rede.

/** Regenera só se a 1ª leva terminou até aqui (ms desde o início do pedido). */
export const REGEN_MAX_ELAPSED_MS = 4000;
/** Teto da chamada de regeneração. */
export const REGEN_TIMEOUT_MS = 3000;
/** O que a regeneração deixa, no mínimo, para o juiz dentro do orçamento. */
export const REGEN_JUDGE_RESERVE_MS = 2000;
/** Pede o que falta + esta folga (forma e filtros podem descartar de novo). */
export const REGEN_EXTRA = 2;

/** Modelo sobrecarregado ou lento: outra chamada agora só pioraria. */
export function overloaded(chat: ChatResult): boolean {
  if (chat.ok) return false;
  if (chat.reason === "timeout") return true;
  return chat.status === 503 || chat.status === 504 || chat.status === 429;
}

export type GenerateRequest = {
  personas: string[];
  avoid: string[];
  timeoutMs: number;
  retries: number;
};

export type RegenInfo = {
  /** Regenerações feitas (0 ou 1). */
  calls: 0 | 1;
  /** Faltou candidata e NÃO regenerou: tarde demais ou modelo sobrecarregado. */
  skipped?: "time" | "overload";
  ms: number;
  /** Candidatas que a regeneração somou (depois de forma e filtros). */
  added: number;
  /** Motivo da falha da chamada de regeneração. */
  fail?: string;
};

export async function gatherCandidates(input: {
  count: number;
  word: string;
  meaning: string;
  /** Definições de bot das rodadas anteriores desta partida. */
  previous: string[];
  /** Memória da rodada (texto normalizado) lida no início do pedido. */
  servedNorms: string[];
  /** Estilos da 1ª chamada (count + extras). */
  personas: string[];
  /** Estilos da regeneração, quando houver (n = o que falta + REGEN_EXTRA). */
  morePersonas: (n: number) => string[];
  genTimeoutMs: number;
  totalBudgetMs: number;
  /** Início do pedido, no relógio `now`. */
  t0: number;
  now: () => number;
  generate: (req: GenerateRequest) => Promise<ChatResult>;
}): Promise<{
  /** Chamada que vale para o evento: a última que respondeu (attempts somados). */
  chat: ChatResult;
  /** Itens lidos das respostas; null = nenhuma resposta utilizável. */
  parsedCount: number | null;
  /** Candidatas aprovadas por forma e filtros, 1ª leva primeiro. */
  candidates: string[];
  dropped: {
    shape: Partial<Record<ShapeIssue, number>>;
    leak: number;
    served: number;
    match: number;
    self: number;
  };
  regen: RegenInfo;
}> {
  const { count, word, meaning, previous, servedNorms } = input;
  const dropped = {
    shape: {} as Partial<Record<ShapeIssue, number>>,
    leak: 0,
    served: 0,
    match: 0,
    self: 0,
  };
  // FORMA primeiro (texto cru do modelo), depois os filtros de sempre; o que
  // já foi aprovado tem prioridade no dedup entre candidatas.
  const filterBatch = (parsed: string[], kept: string[]) => {
    const shape = dropMalformed(parsed, word);
    for (const r of SHAPE_RULES) {
      const n = shape.byRule[r];
      if (n) dropped.shape[r] = (dropped.shape[r] ?? 0) + n;
    }
    const leak = dropNearTruth(shape.kept, meaning);
    const fresh = dropAlreadyServed(leak.kept, servedNorms);
    const notRepeated = dropMatchRepeats(fresh.kept, previous);
    const distinct = dropSelfSimilar([...kept, ...notRepeated.kept]);
    dropped.leak += leak.dropped;
    dropped.served += fresh.dropped;
    dropped.match += notRepeated.dropped;
    dropped.self += distinct.dropped;
    return distinct.kept;
  };

  const first = await input.generate({
    personas: input.personas,
    avoid: avoidList(previous),
    timeoutMs: input.genTimeoutMs,
    retries: 0,
  });
  const parsed1 = first.ok
    ? parseDefinitions(first.content, input.personas.length)
    : null;
  let candidates = filterBatch(parsed1 ?? [], []);

  const regen: RegenInfo = { calls: 0, ms: 0, added: 0 };
  let second: ChatResult | null = null;
  let parsed2: string[] | null = null;
  if (candidates.length < count) {
    const elapsed = input.now() - input.t0;
    const timeoutMs = Math.min(
      REGEN_TIMEOUT_MS,
      input.totalBudgetMs - elapsed - REGEN_JUDGE_RESERVE_MS,
    );
    if (overloaded(first)) regen.skipped = "overload";
    else if (elapsed > REGEN_MAX_ELAPSED_MS || timeoutMs <= 0) {
      regen.skipped = "time";
    } else {
      const n = Math.min(10, count - candidates.length + REGEN_EXTRA);
      const r0 = input.now();
      second = await input.generate({
        personas: input.morePersonas(n),
        // o que a partida usou, o que a rodada já serviu e o que esta
        // chamada já viu (inclusive as quebradas): nada disso de novo
        avoid: avoidList([...previous, ...servedNorms, ...(parsed1 ?? [])], 25),
        timeoutMs,
        retries: 0,
      });
      regen.calls = 1;
      regen.ms = input.now() - r0;
      if (!second.ok) regen.fail = second.reason;
      parsed2 = second.ok ? parseDefinitions(second.content, n) : null;
      const before = candidates.length;
      candidates = filterBatch(parsed2 ?? [], candidates);
      regen.added = candidates.length - before;
    }
  }

  const answered = second?.ok ? second : first.ok ? first : null;
  return {
    chat: {
      ...(answered ?? first),
      attempts: first.attempts + (second?.attempts ?? 0),
    },
    parsedCount:
      parsed1 === null && parsed2 === null
        ? null
        : (parsed1?.length ?? 0) + (parsed2?.length ?? 0),
    candidates,
    dropped,
    regen,
  };
}

/** Campos da regeneração no evento (só números e motivos, nunca texto). */
export function regenEventFields(regen: RegenInfo): Record<string, string | number> {
  const out: Record<string, string | number> = { regen: regen.calls };
  if (regen.skipped) out.regen_skip = regen.skipped;
  if (regen.calls > 0) {
    out.regen_ms = regen.ms;
    out.regen_added = regen.added;
    if (regen.fail) out.regen_fail = regen.fail;
  }
  return out;
}

