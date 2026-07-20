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
