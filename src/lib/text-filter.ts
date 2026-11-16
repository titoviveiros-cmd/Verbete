// Filtro simples de texto: remove espaços extras, limita tamanho e recusa
// palavrões básicos, links e dados de contato.
//
// ECA Digital (11/11/2026): as MESMAS listas e regras valem no servidor —
// public.ugc_text_issue (supabase/migrations/20261111120000_ugc_filtro_servidor.sql),
// aplicada por gatilho em definitions, players.nickname e profiles.display_name.
// Um teste confere que as listas daqui e as da migration são idênticas
// (src/lib/__tests__/ugc-filter-parity.test.ts). É um PISO mínimo: o
// tratamento real de ofensa e assédio é a denúncia + revisão humana.

/** Começo de palavra (texto sem acento, minúsculo): recusado como palavrão. */
export const UGC_BLOCKED = [
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
  "foda",
  "foder",
  "fodido",
  "punheta",
  "boquete",
  "siririca",
  "piroca",
  "xoxota",
  "traveco",
  "sapatao",
  "vadia",
  "babaca",
  "otario",
  "pqp",
  "vsf",
  "vtnc",
  "tnc",
  "krl",
];

/**
 * Começo de palavra que indica contato fora do jogo (rede social, e-mail).
 * Público 13+: troca de contato é o primeiro passo de aliciamento — a
 * definição e o apelido são vistos por desconhecidos da sala.
 */
export const UGC_CONTACT_WORDS = [
  "whatsapp",
  "whatsap",
  "wpp",
  "zapzap",
  "telegram",
  "instagram",
  "discord",
  "tiktok",
  "snapchat",
  "gmail",
  "hotmail",
  "outlook",
];

// Telefone: 8+ dígitos, mesmo separados por espaço, ponto, hífen ou parênteses.
const PHONE_RE = /\d(?:[\s().-]*\d){7,}/;
// @usuario ou e-mail: "@" seguido de 2+ letras/dígitos.
const HANDLE_RE = /@[a-z0-9_]{2}/;

// Normaliza grafia padrão do jogo: minúsculas, sem acentos.
// Mantém ç → c e remove diacríticos. Garante leitura neutra na votação.
export function normalizeForGame(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

// Palavras do texto (normalizado) com os disfarces desfeitos: pontuação no
// meio cola as partes ("fa-ze-da", "f.a.z.e.d.a" → "fazeda") e sequências de
// letras soltas também ("f a z e d a" → "fazeda"). Espaço entre palavras de
// verdade continua separando.
function revealTokens(text: string): string[] {
  const glued = normalizeForGame(text.replace(INVISIBLE_RE, "")).replace(
    /[^a-z0-9\s]+/g,
    "",
  );
  const out: string[] = [];
  let run = "";
  for (const t of glued.split(/\s+/).filter(Boolean)) {
    if (t.length === 1) {
      run += t;
      continue;
    }
    if (run) out.push(run);
    run = "";
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}

/**
 * A definição revela a palavra da rodada? (2.1.4 — nada é mascarado: quem
 * cola a palavra é avisado e corrige.) Vale a palavra inteira como palavra do
 * texto (com plural), mesmo disfarçada por acento, maiúscula, pontuação,
 * espaços entre letras ou caracteres invisíveis — e, para palavras de 6+
 * letras, as derivadas que COMEÇAM pela palavra inteira ("cicerone" →
 * "ciceronear", sala 5873). NÃO vale: trecho dentro de outra palavra ("mar"
 * em "amarelo"), raiz parecida ("guia" × "guiar") nem conjugação de outro
 * verbo. Espelhado no servidor (public.definition_reveals_word).
 */
export function revealsWord(text: string, word: string): boolean {
  const target = revealTokens(word);
  if (!target.length || target.join("").length < 3) return false;
  const toks = revealTokens(text);
  if (target.length > 1) {
    for (let i = 0; i + target.length <= toks.length; i++)
      if (target.every((t, j) => toks[i + j] === t)) return true;
    return false;
  }
  const w = target[0]!;
  return toks.some(
    (t) =>
      t === w ||
      t === `${w}s` ||
      t === `${w}es` ||
      (w.length >= 6 && t.startsWith(w)),
  );
}

// Regra antiga, mais estrita (substring/raiz), só para DESCARTAR texto de
// IA/reserva em definitionShapeIssue — idêntica à da edge dos bots
// (paridade testada); falso positivo ali só troca uma sugestão. Para texto
// de jogador vale revealsWord (sem falso positivo por trecho ou raiz).
function leaksWordStrict(
  normalizedText: string,
  normalizedWord: string,
): boolean {
  if (!normalizedWord || normalizedWord.length < 3) return false;
  if (normalizedText.includes(normalizedWord)) return true;
  const letters = normalizedText.replace(/[^a-z0-9]/g, "");
  if (letters.includes(normalizedWord)) return true;
  if (normalizedWord.length >= 5) {
    const root = normalizedWord.slice(0, normalizedWord.length - 1);
    if (new RegExp(`\\b${root}\\w{0,3}\\b`).test(normalizedText)) return true;
  }
  return false;
}

export type UgcIssue = "link" | "blocked_word" | "contact";
export type DefinitionIssue = "reveals_word" | UgcIssue;

/**
 * Regra comum a todo texto escrito por jogador (definição, apelido, nome
 * exibido): link, palavrão ou contato → motivo; senão null. Espelhada no
 * servidor em public.ugc_text_issue (mesma ordem, mesmas listas).
 */
export function ugcTextIssue(text: string): UgcIssue | null {
  const plain = normalizeForGame(String(text ?? "").replace(INVISIBLE_RE, ""));
  if (/https?:\/\/\S/.test(plain) || /\bwww\./.test(plain)) return "link";
  for (const b of UGC_BLOCKED)
    if (new RegExp(`\\b${b}`).test(plain)) return "blocked_word";
  if (PHONE_RE.test(plain) || HANDLE_RE.test(plain)) return "contact";
  for (const c of UGC_CONTACT_WORDS)
    if (new RegExp(`\\b${c}`).test(plain)) return "contact";
  return null;
}

/** Motivo para recusar (sem alterar) a definição de um jogador, ou null. */
export function definitionIssue(
  text: string,
  word?: string,
): DefinitionIssue | null {
  if (word && revealsWord(text, word)) return "reveals_word";
  return ugcTextIssue(text);
}

export const DEFINITION_ISSUE_MESSAGE: Record<DefinitionIssue, string> = {
  reveals_word: "⚠️ Não vale usar a palavra da rodada!",
  blocked_word: "⚠️ Sem palavrão na definição!",
  link: "⚠️ Sem links na definição!",
  contact: "⚠️ Sem telefone, e-mail, @ ou rede social na definição!",
};

/**
 * O servidor recusou o texto pelo gatilho de conteúdo (erro do Postgres
 * "ugc_rejected:<motivo>")? Devolve o motivo — só acontece com cliente
 * antigo ou chamada direta à API; o app atual recusa antes de enviar.
 */
export function ugcRejectedReason(err: unknown): UgcIssue | null {
  const msg = String((err as { message?: unknown } | null)?.message ?? "");
  const m = /ugc_rejected:(link|blocked_word|contact)\b/.exec(msg);
  return m ? (m[1] as UgcIssue) : null;
}

/** Mensagem para apelido/nome exibido recusado, ou null quando pode usar. */
export function nicknameIssueMessage(nick: string): string | null {
  const issue = ugcTextIssue(nick);
  if (!issue) return null;
  if (issue === "contact")
    return "Sem telefone, e-mail, @ ou rede social no apelido. Não use seu nome real nem contato.";
  return "Esse apelido não é permitido. Escolha outro.";
}

// Só normalização técnica (2.1.4): invisíveis e espaços extras saem, tamanho
// máximo, minúsculas sem acento (grafia neutra da votação). NUNCA mascara —
// texto que revela a palavra, tem palavrão, link ou contato é recusado antes
// do envio (definitionIssue) e no servidor (submit_definition para a palavra;
// gatilho definitions_ugc_guard para palavrão/link/contato, 11/11/2026).
export function sanitizeDefinition(input: string, maxLen = 140): string {
  const t = input
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
  return normalizeForGame(t);
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
 * leaksWordStrict: rejeita em vez de mascarar).
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
  if (word && leaksWordStrict(flat, normalizeForGame(word.trim())))
    return "word";
  return null;
}

/**
 * Texto da IA ou de reserva pronto para a mesa (sanitizado), ou null quando
 * está quebrado — antes OU depois de sanitizar — ou quando seria recusado de
 * um jogador (palavra da rodada, palavrão, link): descarta em vez de virar
 * cédula/sugestão mascarada.
 */
export function wellFormedDefinition(
  raw: string,
  word?: string,
): string | null {
  if (definitionIssue(raw, word)) return null;
  if (definitionShapeIssue(raw, word ?? "")) return null;
  const clean = sanitizeDefinition(raw, 140);
  return definitionShapeIssue(clean, word ?? "") ? null : clean;
}
