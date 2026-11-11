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
//      parecidas entre si;
//   4. NÍVEIS (Red Team 10/11: numa partida longa da mesma classe o banco se
//      esgotava e a lista voltava vazia na 6ª/7ª rodada). Só quando falta
//      candidata, relaxa nesta ordem: (1) variedade DENTRO do pedido
//      (núcleo/trecho repetido), (2) trecho reaproveitado da PARTIDA,
//      (3) Dice contra a PARTIDA — no máximo PARTIDA_RELAX_MAX por pedido.
//      Nunca relaxam: forma, verdade (Dice, raiz, campo) e a RODADA
//      (`avoidRound`: o que 💡/🤖/bots já serviram nela).
// Conteúdo em offline-bank.ts (PENDENTE REVISÃO EDITORIAL).
// Sem APIs do Deno: testável no Vitest (src/lib/__tests__/bots-sem-ia.test.ts).
import {
  definitionShapeIssue,
  dice,
  dropAlreadyServed,
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
  ADJ_MUDA,
  ADJ_PAIRS,
  ADJ_PARTE_QUALS,
  ADJ_PARTES,
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
/** Tentativas de cada nível de relaxamento (só rodam se faltar candidata). */
const RELAX_ATTEMPTS = 200;
/**
 * Nível 3 (Dice contra a partida relaxado): teto por pedido. Na v2 a fila
 * das reservas é cortada em 12 e a edge ainda filtra a partida — com o teto,
 * as reservas fixas seguem completando a fila dos bots.
 */
export const PARTIDA_RELAX_MAX = 3;

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
    const text = pick(rng, [`ressecamento ${prep("de", b)}`, `endurecimento ${prep("de", b)}`]);
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
      return { text: `movimento rápido feito com ${s}`, parts: [s], via: "sufixo-ada" };
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
  // G7 (11/11): molde sorteado na PROPORÇÃO do tamanho da lista (≈ cada
  // definição possível com a mesma chance). Com pesos fixos, os 22 pares
  // saíam em 25% das vezes e se repetiam entre partidas (estresse: 77,6%).
  let r = rng() * ADJ_MOLD_TOTAL;
  for (const m of ADJ_MOLDS) {
    if (r < m.w) return m.make(rng);
    r -= m.w;
  }
  return ADJ_MOLDS[ADJ_MOLDS.length - 1]!.make(rng);
}

type AdjMold = { w: number; make: (rng: () => number) => Candidate };
const ADJ_MOLDS: readonly AdjMold[] = [
  {
    w: ADJ_QUE.length,
    make: (rng) => {
      const q = pick(rng, ADJ_QUE);
      return { text: `que ${q}`, parts: [q], via: "adj-que" };
    },
  },
  {
    // "que racha no frio": a circunstância vem da lista do próprio verbo
    w: ADJ_MUDA.reduce((a, m) => a + m[1].length, 0),
    make: (rng) => {
      const [verb, when] = pick(rng, ADJ_MUDA);
      return { text: `que ${verb} ${pick(rng, when)}`, parts: [verb], via: "adj-que" };
    },
  },
  {
    w: ADJ_PARTES.length * ADJ_PARTE_QUALS.length,
    make: (rng) => {
      const part = pick(rng, ADJ_PARTES);
      const q = agree(pick(rng, ADJ_PARTE_QUALS), part[1]);
      return { text: `que tem ${part[0]} ${q}`, parts: [part[0]], via: "adj-que" };
    },
  },
  {
    w: 2 * ADJ_PROPRIO.length,
    make: (rng) => {
      const q = pick(rng, ADJ_PROPRIO);
      return { text: `${pick(rng, ["próprio", "típico"])} ${q}`, parts: [q], via: "adj-proprio" };
    },
  },
  {
    w: 2 * QUEM.length,
    make: (rng) => {
      const q = pick(rng, QUEM);
      return { text: `${pick(rng, ["próprio", "típico"])} de quem ${q}`, parts: [q], via: "adj-proprio" };
    },
  },
  {
    w: ADJ_RELATIVO.length,
    make: (rng) => {
      const q = pick(rng, ADJ_RELATIVO);
      return { text: `relativo ${q}`, parts: [q], via: "adj-relativo" };
    },
  },
  {
    w: QUEM.length,
    make: (rng) => {
      const q = pick(rng, QUEM);
      return { text: `diz-se de quem ${q}`, parts: [q], via: "adj-dizse" };
    },
  },
  {
    w: ADJ_DIZSE.length,
    make: (rng) => {
      const q = pick(rng, ADJ_DIZSE);
      return { text: `diz-se de ${q}`, parts: [q], via: "adj-dizse" };
    },
  },
  {
    w: ADJ_PAIRS.length,
    make: (rng) => {
      const p = pick(rng, ADJ_PAIRS);
      return { text: p, parts: [p], via: "adj-par" };
    },
  },
];
const ADJ_MOLD_TOTAL = ADJ_MOLDS.reduce((a, m) => a + m.w, 0);

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
      // "de um jeito" (revisão 11/11: "de jeito solene" soava errado)
      ["de um jeito", "m"],
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
  /** O que a PARTIDA já usou (rodadas anteriores): evitado, mas relaxável. */
  avoid?: readonly string[];
  /** O que a RODADA atual já serviu (💡, 🤖, bots): evitado SEMPRE. */
  avoidRound?: readonly string[];
  /**
   * G3 (11/11): faixa do banco por TIPO de chamada. Bots, 🤖 e 💡 da mesma
   * rodada pedem ao mesmo tempo (nenhum vê a gravação do outro); com faixas
   * disjuntas pelo trecho principal, não sorteiam a mesma frase. Ausente =
   * banco inteiro (como antes). Esgotada a faixa, o nível 4 usa o banco todo.
   */
  lane?: OfflineLane;
  /**
   * G3, pior caso simultâneo (11/11 noite): sub-faixa do JOGADOR dentro das
   * faixas 🤖 e 💡 (`laneSlotFor`). Dois humanos pedindo 🤖 (ou 💡) ao mesmo
   * tempo sorteavam na mesma faixa de 10%. A faixa tem OFFLINE_LANE_BUCKETS
   * pedaços e cada jogador sorteia primeiro em 2 deles: dois jogadores só têm
   * a MESMA sub-faixa em 1 de 15 vezes (com 1 pedaço só, eram 1 de 4, e aí o
   * lote inteiro coincidia e saía texto igual). Só vale com `lane` "robo" ou
   * "dica"; ausente = como antes. Faltando, a faixa inteira completa (e,
   * depois, o banco inteiro, como antes).
   */
  laneSlot?: number;
  count: number;
  seed: string;
};

export type OfflineLane = "bots" | "robo" | "dica";
/** Faixa do trecho principal: 10% 🤖, 10% 💡, 80% bots (estável por texto). */
export function laneOf(mainPart: string): OfflineLane {
  const h = hashSeed(normTxt(mainPart)) % 10;
  return h === 0 ? "robo" : h === 1 ? "dica" : "bots";
}

/** Pedaços de cada faixa 🤖/💡; cada jogador fica com 2 (1/3 da faixa). */
export const OFFLINE_LANE_BUCKETS = 6;
/** Sub-faixas possíveis = pares ordenados de pedaços distintos (6 × 5). */
export const OFFLINE_LANE_SLOTS = OFFLINE_LANE_BUCKETS * (OFFLINE_LANE_BUCKETS - 1);

/**
 * Pedaço da faixa do trecho principal. Hash com OUTRO prefixo que o de
 * `laneOf`: com o mesmo hash, `h % 10 === 0` amarraria `h % 6`.
 */
export function laneBucketOf(mainPart: string): number {
  return hashSeed(`subfaixa:${normTxt(mainPart)}`) % OFFLINE_LANE_BUCKETS;
}

/** Os 2 pedaços (distintos) da sub-faixa `slot` (0 ≤ slot < OFFLINE_LANE_SLOTS). */
export function slotBuckets(slot: number): [number, number] {
  const a = Math.floor(slot / (OFFLINE_LANE_BUCKETS - 1));
  return [a, (a + 1 + (slot % (OFFLINE_LANE_BUCKETS - 1))) % OFFLINE_LANE_BUCKETS];
}

/**
 * Sub-faixa de quem pede, a partir de um identificador do pedido (o token
 * da sessão). Só o resto da divisão sai daqui: o valor nunca é gravado nem
 * registrado. Vazio = sem sub-faixa (como antes).
 */
export function laneSlotFor(callerKey: string | null | undefined): number | undefined {
  const k = String(callerKey ?? "");
  if (!k) return undefined;
  return hashSeed(`jogador:${k}`) % OFFLINE_LANE_SLOTS;
}

/**
 * Até `count` definições falsas, distintas, coerentes com a classe e longe
 * da verdade. Com metadados (molde e trechos) — para os testes e a amostra.
 */
export function generateOfflineCandidates(input: OfflineInput): Candidate[] {
  const rng = seededRng(input.seed);
  const klass = inferWordClass(input);
  const category = String(input.category ?? "").trim().toLowerCase();
  const guard = truthGuard(input.meaning ?? "", (input.sinonimos ?? []).filter((s) => typeof s === "string"));
  const norms = (xs: readonly string[] | undefined) =>
    (xs ?? []).map((a) => normTxt(String(a ?? ""))).filter(Boolean);
  const partidaNorms = norms(input.avoid);
  const roundNorms = norms(input.avoidRound);
  const partidaGrams = partidaNorms.map(grams);
  const roundGrams = roundNorms.map(grams);
  const out: Candidate[] = [];
  const outNorms = new Set<string>();
  const usedParts = new Set<string>();
  const usedHeads = new Set<string>();
  const outGrams: Set<string>[] = [];
  const want = Math.max(0, Math.min(20, Math.floor(input.count)));
  const make = () =>
    klass === "verbo"
      ? verbCandidate(input.word, rng)
      : klass === "adjetivo"
        ? adjectiveCandidate(input.word, rng)
        : klass === "adverbio"
          ? adverbCandidate(rng)
          : nounCandidate(input.word, category, rng);
  const repeats = (n: string, g: Set<string>, ns: string[], gs: Set<string>[]) =>
    ns.some((a, k) => a === n || diceSets(gs[k]!, g) > MATCH_REPEAT_THRESHOLD);
  const containsPart = (p: string, ns: string[]) =>
    p.length >= 10 && ns.some((a) => a.includes(p));
  // sub-faixa do jogador: só nas faixas 🤖/💡 e com valor válido
  const slotIn =
    (input.lane === "robo" || input.lane === "dica") &&
    Number.isInteger(input.laneSlot) &&
    input.laneSlot! >= 0 &&
    input.laneSlot! < OFFLINE_LANE_SLOTS
      ? input.laneSlot!
      : undefined;
  const slot = slotIn === undefined ? undefined : slotBuckets(slotIn);
  // nível -1 = estrito na sub-faixa do jogador (só com `laneSlot`); 0 =
  // estrito (o de sempre); 1 = variedade no pedido; 2 = trecho da partida;
  // 3 = Dice contra a partida (com teto); 4 = sem a faixa (só com `lane`).
  // Cada nível só roda se faltar.
  const lastLevel = input.lane ? 4 : 3;
  for (let level = slot === undefined ? 0 : -1; level <= lastLevel && out.length < want; level++) {
    const strict = level <= 0;
    const attempts = strict ? MAX_ATTEMPTS : RELAX_ATTEMPTS;
    const cap = level === 3 ? Math.min(want, out.length + PARTIDA_RELAX_MAX) : want;
    for (let i = 0; i < attempts && out.length < cap; i++) {
      const c = make();
      // checagens baratas primeiro; trigramas só no fim (perfil: 1/3 do tempo)
      if (tooLong(c.text)) continue;
      if (input.lane && level < 4 && laneOf(c.parts[0] ?? c.text) !== input.lane) continue;
      if (level === -1 && !slot!.includes(laneBucketOf(c.parts[0] ?? c.text))) continue;
      // o mesmo núcleo duas vezes no pedido só depois de metade das tentativas
      if (strict && c.head && usedHeads.has(c.head) && i < MAX_ATTEMPTS / 2) continue;
      const partNorms = c.parts.map(normTxt);
      // trecho do banco já usado neste pedido (nível 0) ou na rodada (sempre)
      // ou na partida (níveis 0–1)
      if (
        partNorms.some(
          (p) =>
            (strict && usedParts.has(p)) ||
            containsPart(p, roundNorms) ||
            (level <= 1 && containsPart(p, partidaNorms)),
        )
      )
        continue;
      const n = normTxt(c.text);
      if (!n || outNorms.has(n) || definitionShapeIssue(c.text, input.word)) continue;
      if (truthIssue(c.text, guard)) continue;
      const g = grams(n);
      if (repeats(n, g, roundNorms, roundGrams)) continue;
      if ((level <= 2 || level === 4) && repeats(n, g, partidaNorms, partidaGrams)) continue;
      if (outGrams.some((o) => diceSets(o, g) > SELF_SIMILAR_THRESHOLD)) continue;
      out.push(c);
      outNorms.add(n);
      outGrams.push(g);
      partNorms.forEach((p) => usedParts.add(p));
      if (c.head) usedHeads.add(c.head);
    }
  }
  return out;
}

/**
 * G3 (11/11): reservas extras por pedido no ramo sem IA da v2. O cliente dos
 * bots pula a que colidir com a partida (assembleBotRows) e o 🤖 sorteia
 * entre as devolvidas — por isso TODAS as devolvidas vão à memória da rodada.
 */
export const OFFLINE_RESERVE_EXTRA = 2;

/**
 * O que a edge devolve E grava na memória da rodada: no máximo `want`, sem
 * nada parecido (Dice > MATCH_REPEAT_THRESHOLD, o mesmo critério da partida)
 * com o que outra chamada já serviu (memória relida no fim, `servedNow`) nem
 * entre si — o mesmo jogador vê 🤖 e as duas 💡 lado a lado.
 */
export function offlineServeBatch(
  defs: readonly string[],
  want: number,
  servedNow: readonly string[],
): string[] {
  const max = Math.max(0, Math.floor(want));
  const fresh = dropAlreadyServed([...defs], [...servedNow]).kept;
  const seen = servedNow.map((x) => normTxt(String(x ?? ""))).filter(Boolean);
  const out: string[] = [];
  for (const d of fresh) {
    if (out.length >= max) break;
    const n = normTxt(d);
    if (!n || seen.some((x) => x === n || dice(x, n) > MATCH_REPEAT_THRESHOLD)) continue;
    out.push(d);
    seen.push(n);
  }
  return out;
}

/**
 * G3 (11/11): depois do upsert com ON CONFLICT DO NOTHING + select, fica só
 * o que ESTA chamada gravou — o texto IGUAL que uma chamada simultânea já
 * serviu sai do lote (a gravação no banco é atômica). Retorno inútil (erro,
 * null, vazio) = lote inteiro, exatamente como antes: nunca piora.
 */
export function keepClaimed(batch: readonly string[], claimed: unknown): string[] {
  if (!Array.isArray(claimed) || claimed.length === 0) return [...batch];
  const ok = new Set(
    claimed.map((r) => normTxt(String((r as { norm_text?: unknown } | null)?.norm_text ?? ""))),
  );
  return batch.filter((t) => ok.has(normTxt(t)));
}

export function generateOfflineDefinitions(input: OfflineInput): string[] {
  return generateOfflineCandidates(input).map((c) => c.text);
}
