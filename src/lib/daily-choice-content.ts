// Desafio Diário D1 — conteúdo editorial do modo escolha (sem IA).
// Os distratores são DEFINIÇÕES REAIS de outras palavras publicadas do acervo
// (D-e: "reutilizar o acervo existente", nenhuma chamada de IA). O gerador só
// faz RASCUNHOS determinísticos; nada vai ao jogo sem aprovação humana em
// /admin/daily-choices, e o validador abaixo roda de novo na aprovação.

export type AcervoWord = {
  id: string;
  word: string;
  meaning: string;
  classe?: string | null;
  category?: string | null;
};

// ---------------------------------------------------------------------------
// Normalização e tokens
// ---------------------------------------------------------------------------
const STOP = new Set(
  (
    "a o as os um uma uns umas de da do das dos em na no nas nos por pela pelo pelas pelos " +
    "para com sem que se ou e é ao aos à às como mais muito pouco seu sua seus suas " +
    "algo alguem alguém quem qual onde quando entre sobre sob ate até tipo espécie especie " +
    "pessoa coisa ato acao ação efeito modo forma parte algum alguma"
  ).split(" "),
);

export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Radicais (5 letras) das palavras de conteúdo: ≥ 4 letras e fora da lista de vazias. */
export function contentStems(s: string): Set<string> {
  const out = new Set<string>();
  for (const tok of normalizeText(s).split(/[\s-]+/)) {
    if (tok.length < 4 || STOP.has(tok)) continue;
    out.add(tok.slice(0, 5));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------------------
// Validador (critério 19)
// ---------------------------------------------------------------------------
export const LEN_MIN = 0.6;
export const LEN_MAX = 1.4;
/** Acima disto um distrator é parecido demais com a definição certa (sinônimo/raiz). */
export const SIM_TRUTH_MAX = 0.5;
/** Acima disto dois distratores são praticamente o mesmo texto. */
export const SIM_PAIR_MAX = 0.6;

export type IssueCode =
  | "quantidade"
  | "vazio"
  | "comprimento"
  | "sinonimo"
  | "duplicado"
  | "revela_palavra";

export type Issue = { index: number; code: IssueCode; msg: string };
export type Validation = { ok: boolean; issues: Issue[] };

export function validateChoiceSet(input: {
  word: string;
  truth: string;
  distractors: string[];
}): Validation {
  const issues: Issue[] = [];
  const { word, truth } = input;
  const ds = input.distractors;
  if (ds.length !== 3) {
    issues.push({
      index: -1,
      code: "quantidade",
      msg: `são ${ds.length} distratores; precisa de 3`,
    });
    return { ok: false, issues };
  }
  const tNorm = normalizeText(truth);
  const tLen = truth.trim().length;
  const tStems = contentStems(truth);
  const wordNorm = normalizeText(word);
  const wordStem = wordNorm.slice(0, Math.min(5, wordNorm.length));
  const norms = ds.map((d) => normalizeText(d));
  const stems = ds.map((d) => contentStems(d));

  ds.forEach((d, i) => {
    const norm = norms[i] ?? "";
    const st = stems[i] ?? new Set<string>();
    const len = d.trim().length;
    if (!len) {
      issues.push({ index: i, code: "vazio", msg: "texto vazio" });
      return;
    }
    const ratio = tLen ? len / tLen : 0;
    if (ratio < LEN_MIN || ratio > LEN_MAX)
      issues.push({
        index: i,
        code: "comprimento",
        msg: `${len} caracteres = ${ratio.toFixed(2)}× a correta (aceito: ${LEN_MIN}–${LEN_MAX}×)`,
      });
    if (norm === tNorm || norm.includes(tNorm) || tNorm.includes(norm))
      issues.push({
        index: i,
        code: "duplicado",
        msg: "igual à definição correta",
      });
    else if (jaccard(st, tStems) >= SIM_TRUTH_MAX)
      issues.push({
        index: i,
        code: "sinonimo",
        msg: "parecido demais com a definição correta (mesmas raízes)",
      });
    if (wordStem.length >= 4 && contentStemsHas(norm, wordStem))
      issues.push({
        index: i,
        code: "revela_palavra",
        msg: "contém a própria palavra do desafio",
      });
  });
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      if (
        norms[i] &&
        (norms[i] === norms[j] || jaccard(stems[i]!, stems[j]!) >= SIM_PAIR_MAX)
      )
        issues.push({
          index: j,
          code: "duplicado",
          msg: `igual ou quase igual ao distrator ${i + 1}`,
        });
  return { ok: issues.length === 0, issues };
}

function contentStemsHas(norm: string, stem: string): boolean {
  return norm
    .split(/[\s-]+/)
    .some((tok) => tok.length >= 4 && tok.startsWith(stem));
}

// ---------------------------------------------------------------------------
// Gerador de rascunhos (determinístico, sem IA)
// ---------------------------------------------------------------------------
/** FNV-1a 32 bits: ordem estável e reproduzível entre execuções. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Forma da 1ª palavra: definições de mesma forma não se denunciam pela gramática. */
export function leadShape(meaning: string): string {
  const first = normalizeText(meaning).split(" ")[0] ?? "";
  if (first === "que") return "que";
  if (/(ar|er|ir|or)$/.test(first) && first.length > 3) return "verbo";
  if (/(mente)$/.test(first)) return "adverbio";
  if (/(ado|ido|oso|osa|ivo|iva|ante|ente|vel|al)$/.test(first))
    return "adjetivo";
  return "nome";
}

/** 1ª palavra no plural (heurística: termina em s e não é "que"/curta). */
export function isPluralLead(meaning: string): boolean {
  const first = normalizeText(meaning).split(" ")[0] ?? "";
  return first.length > 3 && /s$/.test(first);
}

export const GEN_LEN_MIN = 0.65;
export const GEN_LEN_MAX = 1.35;

/** Acervo pré-processado UMA vez por lote (o gerador roda no Worker: CPU curta). */
export type PreparedWord = {
  id: string;
  classe: string | null;
  text: string;
  len: number;
  norm: string;
  stems: Set<string>;
  shape: string;
  plural: boolean;
  multi: boolean;
};

export function prepareAcervo(pool: AcervoWord[]): PreparedWord[] {
  return pool.map((p) => {
    const text = p.meaning.trim();
    return {
      id: p.id,
      classe: p.classe ?? null,
      text,
      len: text.length,
      norm: normalizeText(text),
      stems: contentStems(text),
      shape: leadShape(text),
      plural: isPluralLead(text),
      multi: text.includes(";"),
    };
  });
}

/**
 * Escolhe 3 definições de OUTRAS palavras publicadas como distratores:
 *  * comprimento 0,65–1,35× a correta (dentro da faixa do validador);
 *  * sem raízes em comum com a correta e sem a palavra do desafio;
 *  * preferência: mesma classe gramatical, mesma forma de início, mesmo
 *    número (plural × singular) e mesmo formato (vários sentidos com ";");
 *  * os 3 diferentes entre si.
 * Devolve null se o acervo não tiver 3 candidatos bons para esta palavra.
 * `prepared`: passe o resultado de prepareAcervo(pool) ao gerar em lote.
 */
export function draftDistractors(
  target: AcervoWord,
  pool: AcervoWord[],
  prepared: PreparedWord[] = prepareAcervo(pool),
): string[] | null {
  const tLen = target.meaning.trim().length;
  if (!tLen) return null;
  const tNorm = normalizeText(target.meaning);
  const tStems = contentStems(target.meaning);
  const tShape = leadShape(target.meaning);
  const tPlural = isPluralLead(target.meaning);
  const tMulti = target.meaning.includes(";");
  const wNorm = normalizeText(target.word);
  const wStem = wNorm.slice(0, Math.min(5, wNorm.length));
  const seen = new Set<string>();
  const cands: Array<{
    text: string;
    stems: Set<string>;
    pref: number;
    tie: number;
  }> = [];
  for (const p of prepared) {
    if (p.id === target.id) continue;
    const ratio = p.len / tLen; // filtro barato primeiro
    if (ratio < GEN_LEN_MIN || ratio > GEN_LEN_MAX) continue;
    if (!p.norm || p.norm === tNorm || seen.has(p.norm)) continue;
    if (jaccard(p.stems, tStems) > 0) continue;
    if (wStem.length >= 4 && contentStemsHas(p.norm, wStem)) continue;
    seen.add(p.norm);
    let pref = 0;
    if (target.classe && p.classe && target.classe === p.classe) pref += 2;
    if (p.shape === tShape) pref += 1;
    if (p.plural === tPlural) pref += 1;
    if (p.multi === tMulti) pref += 1;
    cands.push({
      text: p.text,
      stems: p.stems,
      pref,
      tie: fnv1a(`${target.id}|${p.id}`),
    });
  }
  cands.sort((a, b) => b.pref - a.pref || a.tie - b.tie);
  const picked: typeof cands = [];
  for (const c of cands) {
    if (picked.some((x) => jaccard(x.stems, c.stems) >= 0.34)) continue;
    picked.push(c);
    if (picked.length === 3) break;
  }
  if (picked.length < 3) return null;
  const out = picked.map((x) => x.text);
  return validateChoiceSet({
    word: target.word,
    truth: target.meaning,
    distractors: out,
  }).ok
    ? out
    : null;
}
