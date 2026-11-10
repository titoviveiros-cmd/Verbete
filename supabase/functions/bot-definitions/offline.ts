// Gerador de definições falsas SEM IA EXTERNA (frente "bots sem IA",
// 10/11/2026). Substitui as 62 reservas genéricas (bot-definitions-v2/
// reserves.ts) SÓ quando o interruptor BOTS_OFFLINE_GENERATOR está ligado
// no ambiente das edges; desligado (padrão), nada muda.
//
// Como funciona (sem rede, determinístico pela semente):
//   1. classe gramatical: coluna `classe` da palavra; sem ela, categoria e
//      terminação ("-ar" = verbo, "-oso" = adjetivo…);
//   2. molde: núcleo + complemento por TIPO coerente com a categoria
//      (objeto → recipiente/ferramenta…), "ato de…" para "-ção/-mento",
//      "estudo dos…" para "-logia", "inflamação da…" para "-ite" etc.;
//   3. filtros: forma (a mesma das edges), palavra da rodada, vazamento da
//      verdade (Dice < LEAK_THRESHOLD), raiz em comum com a verdade ou com
//      os sinônimos, CAMPO SEMÂNTICO em comum (mini-tesauro do banco),
//      repetição na partida/rodada (Dice e trecho reaproveitado) e
//      parecidas entre si.
// Conteúdo em offline-bank.ts (PENDENTE REVISÃO EDITORIAL).
// Sem APIs do Deno: testável no Vitest (src/lib/__tests__/bots-sem-ia.test.ts).
import {
  definitionShapeIssue,
  dice,
  LEAK_THRESHOLD,
  MATCH_REPEAT_THRESHOLD,
  normTxt,
  SELF_SIMILAR_THRESHOLD,
} from "./logic.ts";
import {
  ACT_TAILS,
  ACTS,
  ADJ_CHEIO,
  ADJ_DIZSE,
  ADJ_PAIRS,
  ADJ_PODE,
  ADJ_PROPRIO,
  ADJ_QUE,
  ADJ_RELATIVO,
  ADVERBS,
  ADV_MANNER,
  BECOME,
  BODY_PARTS,
  CATEGORY_KINDS,
  DEFAULT_KINDS,
  GROVES,
  IDEAS,
  MINERAL_QUALS,
  NOUN_KINDS,
  QUEM,
  SEMANTIC_FIELDS,
  STORED,
  STRIKES,
  TOPICS,
  VERB_PAIRS,
  type Gender,
  type NounKind,
  type Topic,
} from "./offline-bank.ts";

/** Interruptor (segredo/variável das edges). Ausente ou outro valor = desligado. */
export const OFFLINE_GENERATOR_ENV = "BOTS_OFFLINE_GENERATOR";

export function offlineGeneratorEnabled(
  get: (k: string) => string | undefined | null,
): boolean {
  const v = get(OFFLINE_GENERATOR_ENV);
  return (
    typeof v === "string" &&
    ["1", "true", "sim", "ligado", "gerador"].includes(v.trim().toLowerCase())
  );
}

export type WordClass = "substantivo" | "adjetivo" | "verbo" | "adverbio";

/** Teto de tamanho: as definições reais têm mediana de 34 caracteres. */
export const OFFLINE_MAX_WORDS = 11;
export const OFFLINE_MAX_CHARS = 72;
/** Tentativas por pedido (cada uma = 1 candidata montada e filtrada). */
const MAX_ATTEMPTS = 400;

// ---------------------------------------------------------------------------
// Semente → PRNG (xmur3 + mulberry32): mesma semente, mesma saída.

function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export function seededRng(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rng() * arr.length)]!;

// ---------------------------------------------------------------------------
// Classe e gênero da palavra.

const CLASS_ALIASES: Record<string, WordClass> = {
  substantivo: "substantivo",
  adjetivo: "adjetivo",
  verbo: "verbo",
  adverbio: "adverbio",
  "advérbio": "adverbio",
  // locuções e interjeições: o molde de advérbio (frase curta) é o mais neutro
  locucao: "adverbio",
  "locução": "adverbio",
};
const CATEGORY_CLASS: Record<string, WordClass> = {
  verbo: "verbo",
  acao: "verbo",
  "ação": "verbo",
  adjetivo: "adjetivo",
  qualidade: "adjetivo",
};

export function inferWordClass(input: {
  word: string;
  classe?: string | null;
  category?: string | null;
}): WordClass {
  const c = normTxt(String(input.classe ?? ""));
  const byClasse = CLASS_ALIASES[c] ?? CLASS_ALIASES[String(input.classe ?? "").trim().toLowerCase()];
  if (byClasse) return byClasse;
  const cat = String(input.category ?? "").trim().toLowerCase();
  if (CATEGORY_CLASS[cat]) return CATEGORY_CLASS[cat]!;
  const w = normTxt(input.word);
  if (w.includes(" ")) return "substantivo";
  if (/(oso|osa|vel|ivo|iva|ento|enta)$/.test(w) && w.length >= 6) return "adjetivo";
  if (/(ar|er|ir)$/.test(w) && w.length >= 5) return "verbo";
  if (/mente$/.test(w) && w.length >= 8) return "adverbio";
  return "substantivo";
}

export function nounGender(word: string): Gender {
  const w = normTxt(word).split(" ")[0] ?? "";
  // "fonema", "idioma": masculinos apesar do -a
  if (/(ema|oma)$/.test(w) && w.length > 5) return "m";
  if (/(a|cao|sao|gem|dade|ice|ite|ose|ez|eza|ura|ude)$/.test(w)) return "f";
  return "m";
}

// ---------------------------------------------------------------------------
// Concordância e contrações.

function agree(s: string, g: Gender): string {
  return s.replace(/\{o\}/g, g === "f" ? "a" : "o");
}

const CONTRACT: Record<string, Record<string, string>> = {
  de: { o: "do", a: "da", os: "dos", as: "das", "": "de" },
  a: { o: "ao", a: "à", os: "aos", as: "às", "": "a" },
  por: { o: "pelo", a: "pela", os: "pelos", as: "pelas", "": "por" },
};
function prep(p: "de" | "a" | "por", t: Topic): string {
  return `${CONTRACT[p]![t[0]] ?? p} ${t[1]}`;
}
const bare = (t: Topic) => (t[0] ? `${t[0]} ${t[1]}` : t[1]);

// ---------------------------------------------------------------------------
// Moldes. Cada candidata leva os TRECHOS do banco que usou (`parts`) e um
// rótulo de molde (`via`) — para a anti-repetição e para os testes.

export type Candidate = { text: string; parts: string[]; via: string; head?: string };

function kindsFor(category: string, rng: () => number): readonly string[] {
  const own = CATEGORY_KINDS[category] ?? DEFAULT_KINDS;
  // 1 em 5: tipo vizinho, de fora da categoria (o blefe clássico de "outro
  // domínio") — mais variedade sem perder a coerência de classe
  return rng() < 0.2 ? DEFAULT_KINDS : own;
}

function nounFromKind(kind: NounKind, g: Gender, rng: () => number, diminutive: boolean): Candidate {
  // poucas prontas = menos chance (não ficarem "manjadas" entre partidas)
  const pairChance = 0.25 * Math.min(1, (kind.pairs?.length ?? 0) / 5);
  if (kind.pairs?.length && rng() < pairChance && !diminutive) {
    const p = pick(rng, kind.pairs);
    return { text: p, parts: [p], via: "par" };
  }
  // núcleo do mesmo gênero da palavra quando houver (soa como verbete)
  const same = kind.heads.filter((h) => h[1] === g);
  const head = pick(rng, same.length > 0 && rng() < 0.8 ? same : kind.heads);
  const qual = agree(pick(rng, kind.quals), head[1]);
  const pres = kind.pre ?? [];
  const pre =
    pres.length > 0 && (diminutive || rng() < 0.15)
      ? `${agree(diminutive ? pres[0]! : pick(rng, pres), head[1])} `
      : "";
  let text = `${pre}${head[0]} ${qual}`;
  const parts = [qual];
  if (kind.tails?.length && text.length < 42 && rng() < 0.35) {
    const tail = agree(pick(rng, kind.tails), head[1]);
    text = `${text}, ${tail}`;
    parts.push(tail);
  }
  return { text, parts, via: "nucleo", head: head[0] };
}

/** Regras de sufixo dos substantivos (null = a palavra não tem o sufixo). */
function nounBySuffix(w: string, g: Gender, rng: () => number): Candidate | null {
  const t = pick(rng, TOPICS);
  if (/logia$/.test(w)) {
    const text = pick(rng, [`estudo ${prep("de", t)}`, `ramo da ciência que estuda ${bare(t)}`, `tratado sobre ${bare(t)}`]);
    return { text, parts: [t[1]], via: "sufixo-logia" };
  }
  if (/fobia$/.test(w)) {
    const text = pick(rng, [`medo exagerado ${prep("de", t)}`, `aversão doentia ${prep("a", t)}`]);
    return { text, parts: [t[1]], via: "sufixo-fobia" };
  }
  if (/filia$/.test(w)) {
    const text = pick(rng, [`gosto exagerado ${prep("por", t)}`, `atração irresistível ${prep("por", t)}`]);
    return { text, parts: [t[1]], via: "sufixo-filia" };
  }
  if (/ite$/.test(w)) {
    if (rng() < 0.5) {
      const b = pick(rng, BODY_PARTS);
      return { text: `inflamação ${prep("de", b)}`, parts: [b[1]], via: "sufixo-ite" };
    }
    const head = pick(rng, [["mineral", "m"], ["rocha", "f"]] as const);
    const q = agree(pick(rng, MINERAL_QUALS), head[1]);
    return { text: `${head[0]} ${q}`, parts: [q], via: "sufixo-ite" };
  }
  if (/ose$/.test(w)) {
    const b = pick(rng, BODY_PARTS);
    const text = pick(rng, [`doença crônica ${prep("de", b)}`, `endurecimento ${prep("de", b)}`]);
    return { text, parts: [b[1]], via: "sufixo-ose" };
  }
  if (/ismo$/.test(w)) {
    const idea = pick(rng, IDEAS);
    if (rng() < 0.5) return { text: `doutrina que defende ${bare(idea)}`, parts: [idea[1]], via: "sufixo-ismo" };
    const act = pick(rng, ACTS);
    return { text: `tendência a ${act}`, parts: [act], via: "sufixo-ismo" };
  }
  if (/ista$/.test(w)) {
    if (rng() < 0.5) {
      const act = pick(rng, ACTS);
      return { text: `quem se dedica a ${act}`, parts: [act], via: "sufixo-ista" };
    }
    const idea = pick(rng, IDEAS);
    return { text: `adepto ${prep("de", idea)}`, parts: [idea[1]], via: "sufixo-ista" };
  }
  if (/(cao|sao|mento|agem)$/.test(w)) {
    const act = pick(rng, ACTS);
    return { text: `${pick(rng, ["ato de", "ação de", "efeito de"])} ${act}`, parts: [act], via: "sufixo-acao" };
  }
  if (/ada$/.test(w) && w.length >= 6) {
    if (rng() < 0.5) {
      const s = pick(rng, STRIKES);
      return { text: `golpe dado com ${s}`, parts: [s], via: "sufixo-ada" };
    }
    const act = pick(rng, ACTS);
    return { text: `ato de ${act}`, parts: [act], via: "sufixo-ada" };
  }
  if (/(dade|ez|eza|ice|encia|ude)$/.test(w)) {
    const q = pick(rng, QUEM);
    return { text: `${pick(rng, ["qualidade de quem", "estado de quem", "mania de quem"])} ${q}`, parts: [q], via: "sufixo-qualidade" };
  }
  if (/(eiro|eira)$/.test(w) && rng() < 0.6) {
    const act = pick(rng, ACTS);
    return { text: `quem vive de ${act}`, parts: [act], via: "sufixo-eiro" };
  }
  if (/ario$/.test(w) && rng() < 0.6) {
    const s = pick(rng, STORED);
    return { text: `lugar onde se guardam ${s}`, parts: [s], via: "sufixo-ario" };
  }
  if (/[^i]al$/.test(w) && w.length >= 6 && rng() < 0.5) {
    const s = pick(rng, GROVES);
    return { text: `terreno coberto de ${s}`, parts: [s], via: "sufixo-al" };
  }
  void g;
  return null;
}

const DIMINUTIVE_RE = /(inho|inha|zinho|zinha|ito|ita|ete|eta|ola|ote|ico)$/;

function nounCandidate(word: string, category: string, rng: () => number): Candidate {
  const w = normTxt(word).split(" ").pop() ?? "";
  const g = nounGender(word);
  if (rng() < 0.45) {
    const bySuffix = nounBySuffix(w, g, rng);
    if (bySuffix) return bySuffix;
  }
  const kind = NOUN_KINDS[pick(rng, kindsFor(category, rng))]!;
  if (kind === NOUN_KINDS.pessoa && rng() < 0.4) {
    const q = pick(rng, QUEM);
    return { text: `${pick(rng, ["pessoa que", "sujeito que", "quem"])} ${q}`, parts: [q], via: "quem" };
  }
  return nounFromKind(kind, g, rng, DIMINUTIVE_RE.test(w) && w.length >= 7 && rng() < 0.6);
}

function adjectiveCandidate(word: string, rng: () => number): Candidate {
  const w = normTxt(word);
  if (/(oso|osa)$/.test(w) && rng() < 0.5) {
    const c = pick(rng, ADJ_CHEIO);
    return { text: `cheio de ${c}`, parts: [c], via: "adj-cheio" };
  }
  if (/vel$/.test(w) && rng() < 0.5) {
    const c = pick(rng, ADJ_PODE);
    return { text: `que pode ser ${c}`, parts: [c], via: "adj-pode" };
  }
  const r = rng();
  if (r < 0.3) {
    const q = pick(rng, ADJ_QUE);
    return { text: `que ${q}`, parts: [q], via: "adj-que" };
  }
  if (r < 0.45) {
    const q = pick(rng, ADJ_PROPRIO);
    return { text: `${pick(rng, ["próprio", "típico"])} ${q}`, parts: [q], via: "adj-proprio" };
  }
  if (r < 0.58) {
    const q = pick(rng, ADJ_RELATIVO);
    return { text: `relativo ${q}`, parts: [q], via: "adj-relativo" };
  }
  if (r < 0.75) {
    if (rng() < 0.5) {
      const q = pick(rng, QUEM);
      return { text: `diz-se de quem ${q}`, parts: [q], via: "adj-dizse" };
    }
    const q = pick(rng, ADJ_DIZSE);
    return { text: `diz-se de ${q}`, parts: [q], via: "adj-dizse" };
  }
  const p = pick(rng, ADJ_PAIRS);
  return { text: p, parts: [p], via: "adj-par" };
}

function verbCandidate(word: string, rng: () => number): Candidate {
  const w = normTxt(word);
  if (/(izar|ificar)$/.test(w) && rng() < 0.5) {
    const b = pick(rng, BECOME);
    return { text: `tornar ${b}`, parts: [b], via: "verbo-tornar" };
  }
  if (/ecer$/.test(w) && rng() < 0.5) {
    const b = pick(rng, BECOME);
    return { text: `${pick(rng, ["tornar-se", "ficar"])} ${b}`, parts: [b], via: "verbo-tornar" };
  }
  if (rng() < 0.15) {
    const p = pick(rng, VERB_PAIRS);
    return { text: p, parts: [p], via: "verbo-par" };
  }
  const act = pick(rng, ACTS);
  const frequent = /(ear|ejar)$/.test(w) ? 0.5 : 0.2;
  if (act.length < 40 && rng() < frequent) {
    const t = pick(rng, ACT_TAILS);
    return { text: `${act}, ${t}`, parts: [act], via: "verbo-acao" };
  }
  return { text: act, parts: [act], via: "verbo-acao" };
}

function adverbCandidate(rng: () => number): Candidate {
  if (rng() < 0.4) {
    const [lead, g] = pick(rng, [
      ["de modo", "m"],
      ["de maneira", "f"],
      ["de jeito", "m"],
    ] as const);
    const m = agree(pick(rng, ADV_MANNER), g);
    return { text: `${lead} ${m}`, parts: [m], via: "adverbio" };
  }
  const a = pick(rng, ADVERBS);
  return { text: a, parts: [a], via: "adverbio" };
}

// ---------------------------------------------------------------------------
// Filtros de segurança (verdade, sinônimos, campos) e de repetição.

/** Palavras genéricas que não contam como "raiz em comum" com a verdade. */
const STOP = new Set(
  (
    "usado usada feito feita parte modo forma relativo proprio tipico quem " +
    "pessoa coisa tipo antigo antiga pequeno pequena grande muito quando " +
    "sobre entre depois antes outro outra mesmo mesma sempre qualquer " +
    "algum alguma certo certa cheio cheia"
  ).split(" "),
);

function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of normTxt(text).split(" ")) {
    if (t.length < 4 || STOP.has(t)) continue;
    out.add(t.slice(0, 5));
  }
  return out;
}

/** Raízes normalizadas uma vez só (o filtro roda centenas de vezes). */
const FIELD_ENTRIES: Array<[string, string[]]> = Object.entries(
  SEMANTIC_FIELDS,
).map(([field, stems]) => [
  field,
  stems.map((x) => normTxt(x).replace(/ /g, "")).filter(Boolean),
]);
export function semanticFields(text: string): Set<string> {
  const toks = normTxt(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (const [field, stems] of FIELD_ENTRIES) {
    if (stems.some((stem) => toks.some((t) => t.startsWith(stem)))) out.add(field);
  }
  return out;
}

export type TruthGuard = {
  truth: string;
  stems: Set<string>;
  fields: Set<string>;
};

export function truthGuard(meaning: string, sinonimos: readonly string[] = []): TruthGuard {
  const all = [meaning, ...sinonimos].join(" , ");
  return { truth: meaning, stems: contentStems(all), fields: semanticFields(all) };
}

/** Motivo de recusa da candidata frente à verdade, ou null. */
/** Trigramas do texto normalizado — o MESMO critério de dice() (logic.ts). */
function grams(norm: string): Set<string> {
  const n = ` ${norm} `;
  const out = new Set<string>();
  for (let i = 0; i <= n.length - 3; i++) out.add(n.slice(i, i + 3));
  return out;
}
function diceSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

export function truthIssue(text: string, g: TruthGuard): "leak" | "stem" | "field" | null {
  if (g.truth && dice(text, g.truth) >= LEAK_THRESHOLD) return "leak";
  for (const s of contentStems(text)) if (g.stems.has(s)) return "stem";
  for (const f of semanticFields(text)) if (g.fields.has(f)) return "field";
  return null;
}

function tooLong(text: string): boolean {
  const words = normTxt(text).split(" ").filter(Boolean).length;
  return words > OFFLINE_MAX_WORDS || text.length > OFFLINE_MAX_CHARS;
}

export type OfflineInput = {
  word: string;
  meaning: string;
  category?: string | null;
  classe?: string | null;
  sinonimos?: readonly string[] | null;
  /** O que a partida/rodada já usou (textos crus ou normalizados). */
  avoid?: readonly string[];
  count: number;
  seed: string;
};

/**
 * Até `count` definições falsas, distintas, coerentes com a classe e longe
 * da verdade. Com metadados (molde e trechos) — para os testes e a amostra.
 */
export function generateOfflineCandidates(input: OfflineInput): Candidate[] {
  const rng = seededRng(input.seed);
  const klass = inferWordClass(input);
  const category = String(input.category ?? "").trim().toLowerCase();
  const guard = truthGuard(input.meaning ?? "", (input.sinonimos ?? []).filter((s) => typeof s === "string"));
  const avoidNorms = (input.avoid ?? []).map((a) => normTxt(String(a ?? ""))).filter(Boolean);
  const out: Candidate[] = [];
  const usedParts = new Set<string>();
  const usedHeads = new Set<string>();
  const avoidGrams = avoidNorms.map(grams);
  const outGrams: Set<string>[] = [];
  const want = Math.max(0, Math.min(20, Math.floor(input.count)));
  for (let i = 0; i < MAX_ATTEMPTS && out.length < want; i++) {
    const c =
      klass === "verbo"
        ? verbCandidate(input.word, rng)
        : klass === "adjetivo"
          ? adjectiveCandidate(input.word, rng)
          : klass === "adverbio"
            ? adverbCandidate(rng)
            : nounCandidate(input.word, category, rng);
    // checagens baratas primeiro; trigramas só no fim (perfil: 1/3 do tempo)
    if (tooLong(c.text)) continue;
    // o mesmo núcleo duas vezes no pedido só depois de metade das tentativas
    if (c.head && usedHeads.has(c.head) && i < MAX_ATTEMPTS / 2) continue;
    const partNorms = c.parts.map(normTxt);
    // trecho do banco já usado neste pedido ou presente no que a partida usou
    if (partNorms.some((p) => usedParts.has(p) || avoidNorms.some((a) => p.length >= 10 && a.includes(p)))) continue;
    const n = normTxt(c.text);
    if (!n || definitionShapeIssue(c.text, input.word)) continue;
    if (truthIssue(c.text, guard)) continue;
    const g = grams(n);
    if (avoidNorms.some((a, k) => a === n || diceSets(avoidGrams[k]!, g) > MATCH_REPEAT_THRESHOLD)) continue;
    if (outGrams.some((o) => diceSets(o, g) > SELF_SIMILAR_THRESHOLD)) continue;
    out.push(c);
    outGrams.push(g);
    partNorms.forEach((p) => usedParts.add(p));
    if (c.head) usedHeads.add(c.head);
  }
  return out;
}

export function generateOfflineDefinitions(input: OfflineInput): string[] {
  return generateOfflineCandidates(input).map((c) => c.text);
}
