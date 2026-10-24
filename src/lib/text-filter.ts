// Filtro simples de texto: remove espaços extras, limita tamanho e censura palavrões básicos.
const BLOCKED = [
  "porra",
  "merda",
  "caralho",
  "puta",
  "fdp",
  "viado",
  "viad0",
  "cuzao",
  "buceta",
  "bct",
  "arrombado",
  "filhodaputa",
];

const LINK_RE = /https?:\/\/\S+/gi;

// Normaliza grafia padrão do jogo: minúsculas, sem acentos.
// Mantém ç → c e remove diacríticos. Garante leitura neutra na votação.
export function normalizeForGame(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Anti-trapaça nível 2: detecta a palavra-alvo "colada" dentro do texto
// mesmo após normalização — cobre acento+maiúscula, separadores invisíveis
// (zero-width, espaços extras, pontuação no meio: "fa-ze-da", "f.a.z.e.d.a").
function leaksWord(normalizedText: string, normalizedWord: string): boolean {
  if (!normalizedWord || normalizedWord.length < 3) return false;
  // 1) substring direta
  if (normalizedText.includes(normalizedWord)) return true;
  // 2) só letras/dígitos: remove qualquer separador entre os caracteres da palavra
  const letters = normalizedText.replace(/[^a-z0-9]/g, "");
  if (letters.includes(normalizedWord)) return true;
  // 3) mesma raiz (pluralização simples / sufixos curtos)
  if (normalizedWord.length >= 5) {
    const root = normalizedWord.slice(0, normalizedWord.length - 1);
    const rootRe = new RegExp(`\\b${root}\\w{0,3}\\b`);
    if (rootRe.test(normalizedText)) return true;
  }
  return false;
}

// Aceita opcionalmente a palavra da rodada para censurar tentativas de "colar a resposta".
// Mantém retrocompatibilidade — quando word=undefined funciona igual à versão anterior.
export function sanitizeDefinition(
  input: string,
  maxLen = 140,
  word?: string,
): string {
  // Remove caracteres de controle e zero-width que poderiam disfarçar a palavra-alvo.
  let t = input
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
  t = t.replace(LINK_RE, "[link]");
  for (const word of BLOCKED) {
    const re = new RegExp(`\\b${word}\\w*`, "gi");
    t = t.replace(re, (m) => "*".repeat(m.length));
  }
  const normalized = normalizeForGame(t);
  if (word) {
    const nw = normalizeForGame(word.trim());
    if (leaksWord(normalized, nw)) {
      // Substitui qualquer ocorrência (incluindo formas separadas) por ***
      // 1) substring direta
      let cleaned = normalized.split(nw).join("***");
      // 2) ocorrências separadas por pontuação/espaço — reescreve como ***
      const sep = nw.split("").join("[\\s\\-._]?");
      cleaned = cleaned.replace(new RegExp(sep, "g"), "***");
      return cleaned;
    }
  }
  return normalized;
}

// Remove "etiquetas" típicas de dicionário no início do significado
// (s.m., s.f., adj., v.t.d., loc., interj., bras., fig., etc.) e
// também rótulos entre parênteses no começo. Humanos nunca digitam isso
// na hora de blefar, então a verdade fica destacada se mantermos.
// Também colapsa "; " e corta após o primeiro "; " ou ". " quando o texto
// fica longo demais, deixando o significado curtinho como uma resposta humana.
export function humanizeMeaning(input: string, maxLen = 90): string {
  let t = normalizeForGame(input).replace(/\s+/g, " ").trim();
  // remove rótulos abreviados no início (até 3 grupos seguidos)
  const abbrev =
    /^(?:\(?[a-z]{1,5}\.(?:[a-z]{1,5}\.)?\)?|\([^)]{1,30}\))(?:\s+|\s*[:;,-]\s*)/;
  for (let i = 0; i < 3; i++) {
    const next = t.replace(abbrev, "");
    if (next === t) break;
    t = next.trim();
  }
  // se ainda tiver várias acepções, fica só com a primeira
  const cut = t.search(/(?:;|\s\|\s|\.\s+(?=[a-z]))/);
  if (cut > 20) t = t.slice(0, cut).trim();
  if (t.length > maxLen) {
    const space = t.lastIndexOf(" ", maxLen);
    t = t.slice(0, space > 40 ? space : maxLen).trim();
  }
  return t.replace(/[.;,:]+$/, "").trim();
}

// Similaridade 0..1 entre textos (Dice sobre trigramas de caracteres do texto
// normalizado). Usada para impedir definições quase iguais na mesma rodada —
// playtest: IA/bots convergiam ("excesso de elegancia mundana" vs "...formal").
export function textSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const n = ` ${normalizeForGame(s)
      .replace(/[^a-z0-9]+/g, " ")
      .trim()} `;
    const out = new Set<string>();
    for (let i = 0; i <= n.length - 3; i++) out.add(n.slice(i, i + 3));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

export function sanitizeNickname(input: string): string {
  return (
    input
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .trim()
      .slice(0, 14) || "Anônimo"
  );
}

// ---------------------------------------------------------------------------
// FORMA da definição gerada (2026-10-24) — CÓPIA de definitionShapeIssue da
// edge (supabase/functions/bot-definitions/logic.ts); um teste garante que as
// duas respondem igual (bot-definitions-logic.test.ts). Defesa do client: o
// texto da IA ou da reserva que chega quebrado ("tecido tecido", "min
// mineral…", "… (3)") é pulado — nunca vira cédula de bot nem sugestão.

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

/** Listas das regras (iguais às do servidor — teste de igualdade). */
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
 * Código da regra de forma violada (SHAPE_RULES) ou null quando o texto está
 * bem formado. `word` = palavra da rodada (R7, com a mesma regra de
 * leaksWord: rejeita em vez de mascarar).
 */
export function definitionShapeIssue(
  text: string,
  word = "",
): ShapeIssue | null {
  const raw = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const flat = normalizeForGame(raw);
  const plain = flat.replace(/[^a-z0-9]+/g, " ").trim();
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
  if (
    raw.startsWith("(") ||
    DICT_LABELS.has((toks[0] ?? "").replace(/\./g, ""))
  ) {
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
  if (word && leaksWord(flat, normalizeForGame(word.trim()))) return "word";
  return null;
}

/**
 * Texto da IA ou de reserva pronto para a mesa (sanitizado), ou null quando
 * está quebrado — antes OU depois de sanitizar: máscara de palavrão ("*"),
 * link ("[link]") ou a palavra da rodada também descartam, em vez de virar
 * cédula/sugestão mascarada.
 */
export function wellFormedDefinition(
  raw: string,
  word?: string,
): string | null {
  if (definitionShapeIssue(raw, word ?? "")) return null;
  const clean = sanitizeDefinition(raw, 140, word);
  return definitionShapeIssue(clean, word ?? "") ? null : clean;
}
