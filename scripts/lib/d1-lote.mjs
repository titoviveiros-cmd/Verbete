// D1 — ferramenta OFFLINE de conferência de um lote de conjuntos do modo escolha
// (palavra + definição certa + 3 alternativas erradas) ANTES da revisão humana.
//
// Não grava, não aprova e não consulta banco: só lê arquivos. Nunca diz que um
// conjunto está "certo": o melhor status possível é PENDENTE (= sem alerta
// automático, ainda depende da leitura humana). Quem aprova é o admin, no painel,
// pelo hash (R6), e o banco recalcula o hash (R1).
//
// Paridade com o servidor: usa as MESMAS funções do app (sem cópia):
//   * validateChoiceSet   → src/lib/daily-choice-content.ts (o Worker grava validacao.ok
//                           com ela; o banco só aprova validacao.ok = true)
//   * setHash, altText,
//     manifestSchema      → src/lib/daily-choice-manifest.ts (hash v1 e formato do manifesto)
//   * definitionIssue,
//     revealsWord         → src/lib/text-filter.ts (palavrões, links, palavra revelada)
// Node ≥ 22.18 (ou 24) importa os .ts direto (remoção de tipos nativa); no vitest também.
import {
  contentStems,
  isPluralLead,
  jaccard,
  leadShape,
  normalizeText,
  validateChoiceSet,
} from "../../src/lib/daily-choice-content.ts";
import {
  ALT_PROIBIDO,
  HASH_RE,
  SET_HASH_VERSION,
  altText,
  manifestSchema,
  setHash,
} from "../../src/lib/daily-choice-manifest.ts";
import { definitionIssue, revealsWord } from "../../src/lib/text-filter.ts";

export { SET_HASH_VERSION, setHash };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Catálogo de alertas. BLOQUEIA = o servidor/banco recusaria ou o jogador veria
// algo certamente errado; REVISAR = heurística para o revisor humano olhar;
// INFO = contexto, não muda o status.
// ---------------------------------------------------------------------------
export const ALERTAS = {
  formato: [
    "BLOQUEIA",
    "formato inválido para o manifesto (id, 3 alternativas, tamanho, quebra de linha)",
  ],
  hash_arquivo: [
    "BLOQUEIA",
    "hash do arquivo ≠ hash recalculado (arquivo alterado depois de gerado)",
  ],
  definicao_mudou: [
    "BLOQUEIA",
    "definição do lote ≠ definição do acervo usado (o hash vai falhar no painel)",
  ],
  fora_do_acervo: [
    "BLOQUEIA",
    "palavra ausente do acervo publicado usado na conferência",
  ],
  validador: [
    "BLOQUEIA",
    "reprovado pelo validador do app (entraria com validacao.ok=false e nunca seria aprovável)",
  ],
  palavra_repetida: [
    "BLOQUEIA",
    "mesma palavra (word_id) em mais de um conjunto",
  ],
  alternativas_iguais_na_tela: [
    "BLOQUEIA",
    "duas das 4 opções ficam iguais depois da formatação da tela",
  ],
  outra_acepcao: [
    "BLOQUEIA",
    "alternativa é a definição de OUTRA entrada com a mesma grafia (seria também correta)",
  ],
  espacos: ["REVISAR", "alternativa com espaço nas pontas ou espaço duplo"],
  palavrao: [
    "REVISAR",
    "palavrão ou link (filtro do app) na definição ou numa alternativa",
  ],
  pista_palavra_na_certa: [
    "REVISAR",
    "a definição certa contém a palavra ou o radical dela (entrega a resposta)",
  ],
  sinonimo_fonte: [
    "REVISAR",
    "a alternativa é a definição de um SINÔNIMO registrado da palavra (pode estar certa também)",
  ],
  contem_sinonimo: [
    "REVISAR",
    "a alternativa contém um sinônimo registrado da palavra",
  ],
  raiz_comum: [
    "REVISAR",
    "alternativa com raízes em comum com a definição certa",
  ],
  vazamento: [
    "REVISAR",
    "alternativa = definição certa de outra palavra deste conjunto de candidatos",
  ],
  repetida_no_lote: [
    "REVISAR",
    "a mesma alternativa aparece em outro conjunto do mesmo lote",
  ],
  repetida_global: ["REVISAR", "a mesma alternativa aparece em 3+ conjuntos"],
  sem_fonte: [
    "REVISAR",
    "alternativa não é a definição de nenhuma palavra do acervo (texto sem origem conhecida)",
  ],
  classe_diferente: [
    "REVISAR",
    "alternativa vem de palavra de outra classe gramatical",
  ],
  pista_forma: [
    "REVISAR",
    "a forma do início (verbo/adjetivo/nome/'que', plural) separa a certa das 3 erradas",
  ],
  pista_tamanho: [
    "REVISAR",
    "a certa é bem mais longa ou bem mais curta que as 3 erradas",
  ],
  tamanho_destoa: [
    "REVISAR",
    "alternativa errada fora de 0,7–1,3× a certa E a mais curta/longa das 4 (o app aceita 0,6–1,4×)",
  ],
  pista_estilo: [
    "REVISAR",
    "sinal de estilo só na certa ou só nas erradas (parênteses, aspas, ';', números)",
  ],
  campo_diferente: [
    "REVISAR",
    "as 3 alternativas vêm de outro campo (categoria) — podem ser elimináveis por absurdo",
  ],
  campo_diferente_parcial: [
    "INFO",
    "2 de 3 alternativas de outro campo (a categoria do acervo é imprecisa)",
  ],
  tema_sensivel: ["REVISAR", "tema delicado para 13+ (lista simples)"],
  pt_pt: ["REVISAR", "marca de português de Portugal"],
  grafia_antiga: [
    "REVISAR",
    "grafia anterior ao Acordo Ortográfico (trema, éia/óia, ôo)",
  ],
  duvida_alta: ["REVISAR", "dúvida editorial registrada (nível alto)"],
  duvida_media: ["REVISAR", "dúvida editorial registrada (nível médio)"],
  duvida_baixa: [
    "INFO",
    "dúvida editorial registrada e conferida (nível baixo)",
  ],
  fonte_divergente: [
    "INFO",
    "a fonte anotada no lote não confere com a do acervo",
  ],
  diario_recente: [
    "INFO",
    "palavra sorteada no Diário (modo juiz) nos últimos 30 dias",
  ],
  fora_do_gerador: [
    "INFO",
    "fora dos critérios do gerador do painel (raridade < 3 ou definição > 80); joga igual",
  ],
};

export const STATUS_PENDENTE = "PENDENTE";
export const STATUS_ALERTA = "ALERTA";

// ---------------------------------------------------------------------------
// Formatação da TELA — espelho de public.daily_choice_fmt (migration 20261108120000):
// btrim, tira [espaço . ; , :] do fim e põe a 1ª letra em maiúscula.
// ---------------------------------------------------------------------------
export function formatoTela(s) {
  const x = String(s ?? "")
    .replace(/^ +| +$/g, "")
    .replace(/[\s.;,:]+$/u, "");
  return x.slice(0, 1).toUpperCase() + x.slice(1);
}

const chaveTela = (s) => formatoTela(s).toLocaleLowerCase("pt-BR");

// ---------------------------------------------------------------------------
// Leitura tolerante dos arquivos (saída de `supabase db query -o json`, array puro…)
// ---------------------------------------------------------------------------
function acharArray(v, pred, depth = 0) {
  if (depth > 6 || v == null) return null;
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => x && typeof x === "object" && pred(x)))
      return v;
    for (const x of v) {
      const r = acharArray(x, pred, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof v === "object")
    for (const x of Object.values(v)) {
      const r = acharArray(x, pred, depth + 1);
      if (r) return r;
    }
  return null;
}

/** Palavras publicadas: [{id, word, meaning, classe, category, rarity}] em qualquer embrulho. */
export function lerAcervo(raw) {
  const arr = acharArray(
    raw,
    (x) => "id" in x && "word" in x && "meaning" in x,
  );
  if (!arr) throw new Error("acervo: nenhuma lista com {id, word, meaning}");
  return arr.map((x) => ({
    id: String(x.id),
    word: String(x.word),
    meaning: String(x.meaning),
    classe: typeof x.classe === "string" ? x.classe : null,
    category: typeof x.category === "string" ? x.category : null,
    rarity: typeof x.rarity === "number" ? x.rarity : null,
  }));
}

/** Extras (opcional): sinônimos por id + palavras sorteadas no Diário em 30 dias. */
export function lerExtras(raw) {
  const sin = new Map();
  const ex = acharArray(raw, (x) => "id" in x && "sinonimos" in x) ?? [];
  for (const x of ex)
    sin.set(
      String(x.id),
      Array.isArray(x.sinonimos) ? x.sinonimos.map(String) : [],
    );
  const d30 = findKey(raw, "diario30");
  const diario30 = new Set((Array.isArray(d30) ? d30 : []).map(String));
  return { sinonimos: sin, diario30 };
}

function findKey(v, key, depth = 0) {
  if (depth > 6 || v == null || typeof v !== "object") return undefined;
  if (!Array.isArray(v) && key in v) return v[key];
  for (const x of Object.values(v)) {
    const r = findKey(x, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/**
 * Conjuntos candidatos. Aceita {lotes:[{lote, conjuntos:[…]}]} (formato da revisão
 * de 09/11) ou um array de conjuntos {word_id, distractors[3], word?, truth?, hash?,
 * lote?, fontes?}. Sem `truth`, usa a definição do acervo (e o hash é calculado).
 */
export function lerConjuntos(raw, loteFixo) {
  const out = [];
  if (raw && Array.isArray(raw.lotes)) {
    for (const l of raw.lotes)
      for (const c of l.conjuntos ?? [])
        out.push({ ...c, lote: String(loteFixo ?? l.lote) });
  } else if (Array.isArray(raw)) {
    for (const c of raw)
      out.push({ ...c, lote: String(loteFixo ?? c.lote ?? "?") });
  } else throw new Error("conjuntos: esperava {lotes:[…]} ou uma lista");
  return out.map((c, i) => ({
    word_id: String(c.word_id ?? ""),
    word: c.word != null ? String(c.word) : null,
    truth: c.truth != null ? String(c.truth) : null,
    distractors: Array.isArray(c.distractors)
      ? c.distractors.map((d) => String(d))
      : [],
    hash: c.hash != null ? String(c.hash) : null,
    fontes: Array.isArray(c.fontes) ? c.fontes.map(String) : null,
    lote: c.lote,
    n: c.n ?? null,
    _ordem: i,
  }));
}

// ---------------------------------------------------------------------------
// Heurísticas de texto
// ---------------------------------------------------------------------------
const tokens = (s) =>
  normalizeText(s)
    .split(/[\s-]+/)
    .filter(Boolean);

const SENSIVEL = [
  "sexo",
  "sexua",
  "erotic",
  "pornog",
  "prostitu",
  "meretri",
  "droga",
  "entorpec",
  "embriag",
  "bebado",
  "suicid",
  "assassin",
  "cadaver",
  "tortur",
  "estupr",
  "cocain",
  "maconh",
  "nazis",
  "genocid",
  "aborto",
  "abortar",
  "orgia",
  "obscen",
  "lascivi",
];
const PT_PT = [
  "facto",
  "contacto",
  "equipa",
  "registo",
  "ecra",
  "autocarro",
  "comboio",
  "telemovel",
  "rapariga",
  "miudo",
  "miuda",
  "frigorifico",
  "pequeno-almoco",
  "guarda-redes",
  "sumo",
  "casa de banho",
  "talho",
  "montra",
  "peao",
  "utente",
];

export function temaSensivel(s) {
  const toks = tokens(s);
  return SENSIVEL.filter((p) => toks.some((t) => t.startsWith(p)));
}

export function marcasPtPt(s) {
  const n = ` ${normalizeText(s)} `;
  return PT_PT.filter((p) => n.includes(` ${p} `));
}

export function grafiaAntiga(s) {
  const out = [];
  if (/[üÜ]/.test(s)) out.push("trema");
  if (/[éó]ias?\b/i.test(s)) out.push("éia/óia");
  if (/ôo/i.test(s)) out.push("ôo");
  return out;
}

function sinaisEstilo(s) {
  return {
    parenteses: /[()]/.test(s),
    aspas: /["“”'‘’«»]/.test(s),
    ponto_virgula: s.includes(";"),
    numero: /\d/.test(s),
  };
}

const radical = (w) => {
  const n = normalizeText(w).replace(/[\s-]+/g, "");
  return n.length >= 6 ? n.slice(0, Math.max(5, n.length - 3)) : null;
};

// ---------------------------------------------------------------------------
// Conferência
// ---------------------------------------------------------------------------
function alerta(codigo, detalhe, alt = null) {
  const [nivel, texto] = ALERTAS[codigo];
  return { codigo, nivel, texto, detalhe: detalhe ?? "", alternativa: alt };
}

/**
 * Confere todos os conjuntos. `opts`: { acervo, extras?, duvidas? ({palavra: [nível, texto, …]}),
 * repetidaGlobalMin? (padrão 3) }. Devolve { conjuntos: [...], resumo }.
 */
export async function conferirLote(conjuntos, opts) {
  const acervo = opts.acervo ?? [];
  const extras = opts.extras ?? { sinonimos: new Map(), diario30: new Set() };
  const duvidas = opts.duvidas ?? {};
  const repMin = opts.repetidaGlobalMin ?? 3;

  const porId = new Map(acervo.map((w) => [w.id, w]));
  const porSignificado = new Map(); // significado normalizado → palavras do acervo
  const porGrafia = new Map(); // grafia normalizada → palavras do acervo
  for (const w of acervo) {
    const k = normalizeText(w.meaning);
    if (!porSignificado.has(k)) porSignificado.set(k, []);
    porSignificado.get(k).push(w);
    const g = normalizeText(w.word);
    if (!porGrafia.has(g)) porGrafia.set(g, []);
    porGrafia.get(g).push(w);
  }

  // completa word/truth a partir do acervo quando o lote não traz
  const cs = conjuntos.map((c) => {
    const w = porId.get(c.word_id);
    return {
      ...c,
      word: c.word ?? w?.word ?? "?",
      truth: c.truth ?? w?.meaning ?? "",
      _acervo: w ?? null,
    };
  });

  // índices entre conjuntos
  const contaId = new Map();
  for (const c of cs) contaId.set(c.word_id, (contaId.get(c.word_id) ?? 0) + 1);
  const verdadePor = new Map(); // verdade normalizada → conjuntos
  for (const c of cs) {
    const k = normalizeText(c.truth);
    if (!verdadePor.has(k)) verdadePor.set(k, []);
    verdadePor.get(k).push(c);
  }
  const usoAlt = new Map(); // alternativa normalizada → [{lote, word}]
  for (const c of cs)
    for (const d of new Set(c.distractors.map((x) => normalizeText(x)))) {
      if (!usoAlt.has(d)) usoAlt.set(d, []);
      usoAlt.get(d).push({ lote: c.lote, word: c.word, word_id: c.word_id });
    }

  const saida = [];
  for (const c of cs) {
    const al = [];
    const ds = c.distractors;
    const w = c._acervo;

    // 1) formato do manifesto (mesmo zod do painel)
    const item = {
      word_id: c.word_id,
      palavra: c.word?.slice(0, 80),
      distractors: ds,
      hash: c.hash ?? "0".repeat(64),
    };
    const z = manifestSchema.safeParse({
      versao_hash: SET_HASH_VERSION,
      itens: [item],
    });
    if (!z.success)
      al.push(
        alerta(
          "formato",
          z.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.slice(2).join(".")}: ${i.message}`)
            .join("; "),
        ),
      );
    else if (c.hash && !HASH_RE.test(c.hash))
      al.push(alerta("formato", "hash não é hex de 64"));
    if (ALT_PROIBIDO.test(c.truth))
      al.push(
        alerta(
          "formato",
          "a definição certa tem quebra de linha/controle (junção do hash ambígua)",
        ),
      );
    ds.forEach((d, i) => {
      if (d !== d.trim() || /\s{2,}/.test(d))
        al.push(alerta("espacos", `alternativa ${i + 1}`, i));
    });

    // 2) hash e definição × acervo
    const hashCalc =
      UUID_RE.test(c.word_id) && ds.length === 3
        ? await setHash(c.word_id, c.truth, ds)
        : null;
    if (c.hash && hashCalc && c.hash !== hashCalc)
      al.push(
        alerta(
          "hash_arquivo",
          `${c.hash.slice(0, 12)}… ≠ ${hashCalc.slice(0, 12)}…`,
        ),
      );
    if (!w) al.push(alerta("fora_do_acervo", c.word_id));
    else if (w.meaning !== c.truth)
      al.push(alerta("definicao_mudou", `acervo: "${w.meaning}"`));

    // 3) validador do app (o mesmo que grava validacao.ok)
    if (ds.length === 3) {
      const v = validateChoiceSet({
        word: c.word,
        truth: c.truth,
        distractors: ds.map((d) => altTextOk(d)),
      });
      for (const i of v.issues)
        al.push(
          alerta(
            "validador",
            `${i.code}: ${i.msg}`,
            i.index >= 0 ? i.index : null,
          ),
        );
    }
    if ((contaId.get(c.word_id) ?? 0) > 1)
      al.push(alerta("palavra_repetida", `${contaId.get(c.word_id)}×`));

    // 4) as 4 opções como o jogador vê
    const tela = [c.truth, ...ds].map(chaveTela);
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++)
        if (tela[i] === tela[j])
          al.push(
            alerta(
              "alternativas_iguais_na_tela",
              `${i === 0 ? "certa" : `alt ${i}`} = alt ${j}`,
              j - 1,
            ),
          );

    // 5) palavrões/links, palavra revelada
    for (const [i, t] of [c.truth, ...ds].entries()) {
      const p = definitionIssue(t);
      if (p)
        al.push(
          alerta(
            "palavrao",
            `${i === 0 ? "certa" : `alt ${i}`}: ${p}`,
            i ? i - 1 : null,
          ),
        );
    }
    const rad = radical(c.word);
    if (revealsWord(c.truth, c.word))
      al.push(
        alerta("pista_palavra_na_certa", "a palavra aparece na definição"),
      );
    else if (rad && tokens(c.truth).some((t) => t.startsWith(rad)))
      al.push(alerta("pista_palavra_na_certa", `radical "${rad}"`));

    // 6) origem de cada alternativa no acervo
    const sinAlvo = new Set(
      (extras.sinonimos.get(c.word_id) ?? []).map((s) => normalizeText(s)),
    );
    const fontesAcervo = ds.map((d) =>
      (porSignificado.get(normalizeText(d)) ?? []).filter(
        (x) => x.id !== c.word_id,
      ),
    );
    const grafiaAlvo = normalizeText(c.word);
    ds.forEach((d, i) => {
      const fs = fontesAcervo[i];
      if (!fs.length) al.push(alerta("sem_fonte", `alternativa ${i + 1}`, i));
      if (fs.some((f) => normalizeText(f.word) === grafiaAlvo))
        al.push(
          alerta(
            "outra_acepcao",
            `alternativa ${i + 1} = definição de outra entrada "${c.word}"`,
            i,
          ),
        );
      for (const f of fs) {
        const sinF = new Set(
          (extras.sinonimos.get(f.id) ?? []).map((s) => normalizeText(s)),
        );
        if (sinAlvo.has(normalizeText(f.word)) || sinF.has(grafiaAlvo))
          al.push(
            alerta(
              "sinonimo_fonte",
              `alternativa ${i + 1} vem de "${f.word}"`,
              i,
            ),
          );
      }
      const toks = new Set(tokens(d));
      const sinNa = [...sinAlvo].filter(
        (s) => !s.includes(" ") && s.length >= 4 && toks.has(s),
      );
      if (sinNa.length)
        al.push(
          alerta(
            "contem_sinonimo",
            `alternativa ${i + 1}: ${sinNa.join(", ")}`,
            i,
          ),
        );
      const jac = jaccard(contentStems(d), contentStems(c.truth));
      if (jac >= 0.25 && jac < 0.5)
        al.push(
          alerta("raiz_comum", `alternativa ${i + 1}: ${jac.toFixed(2)}`, i),
        );
      if (
        c.fontes &&
        c.fontes[i] &&
        fs.length &&
        !fs.some((f) => f.word === c.fontes[i])
      )
        al.push(
          alerta(
            "fonte_divergente",
            `alternativa ${i + 1}: lote "${c.fontes[i]}", acervo "${fs.map((f) => f.word).join(", ")}"`,
            i,
          ),
        );
      // vazamento: é a resposta certa de outro candidato
      const outros = (verdadePor.get(normalizeText(d)) ?? []).filter(
        (o) => o.word_id !== c.word_id,
      );
      if (outros.length)
        al.push(
          alerta(
            "vazamento",
            `alternativa ${i + 1} = resposta de "${outros.map((o) => `${o.word} (lote ${o.lote})`).join(", ")}"`,
            i,
          ),
        );
      const usos = (usoAlt.get(normalizeText(d)) ?? []).filter(
        (u) => u.word_id !== c.word_id,
      );
      const noLote = usos.filter((u) => u.lote === c.lote);
      if (noLote.length)
        al.push(
          alerta(
            "repetida_no_lote",
            `alternativa ${i + 1} também em "${noLote.map((u) => u.word).join(", ")}"`,
            i,
          ),
        );
      if (usos.length + 1 >= repMin)
        al.push(
          alerta(
            "repetida_global",
            `alternativa ${i + 1} em ${usos.length + 1} conjuntos`,
            i,
          ),
        );
    });

    // 7) gramática e forma
    if (w?.classe) {
      ds.forEach((d, i) => {
        const cl = [
          ...new Set(fontesAcervo[i].map((f) => f.classe).filter(Boolean)),
        ];
        if (cl.length && !cl.includes(w.classe))
          al.push(
            alerta(
              "classe_diferente",
              `alternativa ${i + 1}: ${cl.join("/")} × ${w.classe}`,
              i,
            ),
          );
      });
    }
    if (ds.length === 3) {
      const fT = leadShape(c.truth);
      const fA = ds.map((d) => leadShape(d));
      if (fA.every((f) => f === fA[0]) && fA[0] !== fT)
        al.push(
          alerta(
            "pista_forma",
            `certa começa como ${fT}; as 3 erradas como ${fA[0]}`,
          ),
        );
      const pT = isPluralLead(c.truth);
      const pA = ds.map((d) => isPluralLead(d));
      if (pA.every((p) => p !== pT))
        al.push(
          alerta(
            "pista_forma",
            `certa no ${pT ? "plural" : "singular"}; as 3 erradas no ${pT ? "singular" : "plural"}`,
          ),
        );
      // tamanho (como na tela)
      const lt = formatoTela(c.truth).length;
      const la = ds.map((d) => formatoTela(d).length);
      const mx = Math.max(...la);
      const mn = Math.min(...la);
      if (lt > mx && lt >= mx * 1.2)
        al.push(
          alerta("pista_tamanho", `certa ${lt} car.; a maior errada ${mx}`),
        );
      if (lt < mn && lt <= mn * 0.8)
        al.push(
          alerta("pista_tamanho", `certa ${lt} car.; a menor errada ${mn}`),
        );
      // só quando a alternativa é a ponta (a mais curta ou a mais longa das 4): é a que se elimina
      const todas = [lt, ...la];
      la.forEach((l, i) => {
        const r = lt ? l / lt : 0;
        const ponta = l === Math.min(...todas) || l === Math.max(...todas);
        if (ponta && (r < 0.7 || r > 1.3) && r >= 0.6 && r <= 1.4)
          al.push(
            alerta(
              "tamanho_destoa",
              `alternativa ${i + 1}: ${r.toFixed(2)}× a certa e a ${l === Math.min(...todas) ? "mais curta" : "mais longa"} das 4`,
              i,
            ),
          );
      });
      // estilo
      const sT = sinaisEstilo(c.truth);
      const sA = ds.map(sinaisEstilo);
      for (const k of Object.keys(sT)) {
        const nA = sA.filter((s) => s[k]).length;
        if (sT[k] && nA === 0)
          al.push(alerta("pista_estilo", `${k.replace("_", "-")} só na certa`));
        if (!sT[k] && nA === 3)
          al.push(
            alerta("pista_estilo", `${k.replace("_", "-")} só nas erradas`),
          );
      }
      // campo semântico
      if (w?.category) {
        const fora = fontesAcervo.filter(
          (fs) => fs.length && !fs.some((f) => f.category === w.category),
        ).length;
        if (fora === 3)
          al.push(alerta("campo_diferente", `3 de 3 fora de "${w.category}"`));
        else if (fora === 2)
          al.push(
            alerta("campo_diferente_parcial", `2 de 3 fora de "${w.category}"`),
          );
      }
    }

    // 8) conteúdo
    for (const [i, t] of [c.word, c.truth, ...ds].entries()) {
      const nome = i === 0 ? "palavra" : i === 1 ? "certa" : `alt ${i - 1}`;
      const alt = i >= 2 ? i - 2 : null;
      const s = temaSensivel(t);
      if (s.length)
        al.push(alerta("tema_sensivel", `${nome}: ${s.join(", ")}`, alt));
      const p = marcasPtPt(t);
      if (p.length) al.push(alerta("pt_pt", `${nome}: ${p.join(", ")}`, alt));
      const g = grafiaAntiga(t);
      if (g.length)
        al.push(alerta("grafia_antiga", `${nome}: ${g.join(", ")}`, alt));
    }
    const du = duvidas[c.word];
    if (Array.isArray(du)) {
      const nivel = String(du[0] ?? "").toLowerCase();
      const cod =
        nivel === "alto"
          ? "duvida_alta"
          : nivel === "medio" || nivel === "médio"
            ? "duvida_media"
            : "duvida_baixa";
      al.push(alerta(cod, [du[2], du[3], du[1]].filter(Boolean).join(" · ")));
    }
    if (extras.diario30.has(c.word_id)) al.push(alerta("diario_recente", ""));
    if (w && ((w.rarity != null && w.rarity < 3) || w.meaning.length > 80))
      al.push(
        alerta(
          "fora_do_gerador",
          `raridade ${w.rarity}, ${w.meaning.length} car.`,
        ),
      );

    const bloqueia = al.filter((a) => a.nivel === "BLOQUEIA").length;
    const revisar = al.filter((a) => a.nivel === "REVISAR").length;
    saida.push({
      lote: c.lote,
      n: c.n,
      word_id: c.word_id,
      palavra: c.word,
      classe: w?.classe ?? null,
      categoria: w?.category ?? null,
      definicao: c.truth,
      alternativas: ds,
      tela: [c.truth, ...ds].map(formatoTela),
      fontes: fontesAcervo.map((fs, i) =>
        fs.length
          ? fs.map((f) => f.word).join(" / ")
          : (c.fontes?.[i] ?? "?") + " (sem fonte no acervo)",
      ),
      hash: hashCalc ?? c.hash,
      status: bloqueia + revisar ? STATUS_ALERTA : STATUS_PENDENTE,
      bloqueia,
      revisar,
      alertas: al,
    });
  }

  // numera dentro do lote (ordem do arquivo) quando não vier n
  const seq = new Map();
  for (const s of saida) {
    const k = s.lote;
    seq.set(k, (seq.get(k) ?? 0) + 1);
    if (s.n == null) s.n = seq.get(k);
  }
  return { conjuntos: saida, resumo: resumir(saida) };
}

/** A alternativa como o servidor a grava (zod altText apara); inválida volta crua. */
function altTextOk(d) {
  const r = altText.safeParse(d);
  return r.success ? r.data : d;
}

export function resumir(cs) {
  const porStatus = {};
  const porCodigo = {};
  const conjuntosPorCodigo = {};
  const porLote = {};
  for (const c of cs) {
    porStatus[c.status] = (porStatus[c.status] ?? 0) + 1;
    porLote[c.lote] ??= { total: 0, PENDENTE: 0, ALERTA: 0, com_bloqueio: 0 };
    porLote[c.lote].total++;
    porLote[c.lote][c.status]++;
    if (c.bloqueia) porLote[c.lote].com_bloqueio++;
    const vistos = new Set();
    for (const a of c.alertas) {
      porCodigo[a.codigo] = (porCodigo[a.codigo] ?? 0) + 1;
      if (!vistos.has(a.codigo))
        conjuntosPorCodigo[a.codigo] = (conjuntosPorCodigo[a.codigo] ?? 0) + 1;
      vistos.add(a.codigo);
    }
  }
  return {
    total: cs.length,
    por_status: porStatus,
    com_bloqueio: cs.filter((c) => c.bloqueia).length,
    alertas_por_codigo: porCodigo,
    conjuntos_por_codigo: conjuntosPorCodigo,
    por_lote: porLote,
  };
}

// ---------------------------------------------------------------------------
// CSV (separador ";" + BOM: abre direto no Excel em português)
// ---------------------------------------------------------------------------
export function csvCampo(v) {
  const s = v == null ? "" : String(v);
  return /[";\r\n]/.test(s) || /^\s|\s$/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function paraCsv(cabecalho, linhas) {
  return (
    "﻿" +
    [cabecalho, ...linhas].map((l) => l.map(csvCampo).join(";")).join("\r\n") +
    "\r\n"
  );
}

/** Lê CSV com ";" ou "," (detecta pelo cabeçalho), aspas e quebras de linha dentro de campo. */
export function lerCsv(texto) {
  const t = String(texto).replace(/^﻿/, "");
  const primeira = t.split(/\r?\n/, 1)[0] ?? "";
  const sep =
    (primeira.match(/;/g) ?? []).length >= (primeira.match(/,/g) ?? []).length
      ? ";"
      : ",";
  const rows = [];
  let row = [];
  let f = "";
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') {
        f += '"';
        i++;
      } else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      row.push(f);
      f = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += ch;
  }
  if (f !== "" || row.length) {
    row.push(f);
    rows.push(row);
  }
  const [cab, ...resto] = rows.filter((r) => r.some((x) => x !== ""));
  return (resto ?? []).map((r) =>
    Object.fromEntries((cab ?? []).map((k, i) => [k.trim(), r[i] ?? ""])),
  );
}

export const COLUNAS_REVISAO = [
  "lote",
  "nº",
  "palavra",
  "classe",
  "categoria",
  "definição certa (como na tela)",
  "alternativa errada 1",
  "de onde veio a 1",
  "alternativa errada 2",
  "de onde veio a 2",
  "alternativa errada 3",
  "de onde veio a 3",
  "status automático",
  "BLOQUEIA (servidor recusaria)",
  "REVISAR (heurística)",
  "dúvida editorial",
  "INFO",
  "DECISÃO (aprovar / corrigir / rejeitar)",
  "observação do revisor",
  "word_id",
  "hash",
];

/** Linhas da planilha de revisão humana (uma por conjunto). */
export function linhasRevisao(cs) {
  const txt = (c, nivel, excluir = []) =>
    c.alertas
      .filter((a) => a.nivel === nivel && !excluir.includes(a.codigo))
      .map((a) => `[${a.codigo}] ${a.detalhe || a.texto}`)
      .join(" | ");
  return cs.map((c) => [
    c.lote,
    c.n,
    c.palavra,
    c.classe ?? "",
    c.categoria ?? "",
    c.tela[0],
    c.tela[1],
    c.fontes[0],
    c.tela[2],
    c.fontes[1],
    c.tela[3],
    c.fontes[2],
    c.status,
    txt(c, "BLOQUEIA"),
    txt(c, "REVISAR", ["duvida_alta", "duvida_media"]),
    c.alertas
      .filter((a) => a.codigo.startsWith("duvida_"))
      .map(
        (a) =>
          `${a.codigo === "duvida_alta" ? "ALTA" : a.codigo === "duvida_media" ? "MÉDIA" : "baixa"}: ${a.detalhe}`,
      )
      .join(" | "),
    txt(c, "INFO"),
    "",
    "",
    c.word_id,
    c.hash,
  ]);
}

// ---------------------------------------------------------------------------
// Decisões → manifesto (só "aprovar" cujo hash confere; nada é aprovado aqui)
// ---------------------------------------------------------------------------
const semAcento = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

export function normalizarDecisao(s) {
  const d = semAcento(s);
  if (["aprovar", "aprovado", "aprova", "sim", "ok"].includes(d))
    return "aprovar";
  if (["corrigir", "editar", "corrige"].includes(d)) return "corrigir";
  if (["rejeitar", "reprovar", "reprovado", "rejeitado", "nao"].includes(d))
    return "rejeitar";
  return d ? `desconhecida:${d}` : null;
}

/**
 * Lê decisões da planilha (CSV preenchido) ou do `decisoes-d1.json` exportado pela
 * REVISAO-D1.html. Chave = word_id; cada decisão carrega o hash do que foi revisado.
 */
export function lerDecisoes(texto) {
  const t = String(texto).replace(/^﻿/, "").trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    return (j.itens ?? []).map((x) => ({
      word_id: String(x.word_id ?? ""),
      palavra: x.palavra ?? "",
      decisao: normalizarDecisao(x.decisao),
      hash: String(x.hash ?? "")
        .toLowerCase()
        .replace(/[^0-9a-f]/g, ""),
      nota: x.nota ?? "",
    }));
  }
  return lerCsv(t).map((r) => {
    const kDec = Object.keys(r).find((k) => semAcento(k).startsWith("decisao"));
    const kObs = Object.keys(r).find((k) =>
      semAcento(k).startsWith("observacao"),
    );
    return {
      word_id: String(r.word_id ?? "").trim(),
      palavra: r.palavra ?? "",
      decisao: normalizarDecisao(kDec ? r[kDec] : ""),
      hash: String(r.hash ?? "")
        .toLowerCase()
        .replace(/[^0-9a-f]/g, ""),
      nota: kObs ? r[kObs] : "",
    };
  });
}

/**
 * Monta o manifesto de UM lote. Entra só quem: foi marcado "aprovar", tem hash da
 * decisão = hash recalculado do conjunto, e não tem alerta BLOQUEIA. O resultado
 * passa pelo MESMO parseManifest do painel (manifestSchema) antes de ser devolvido.
 */
export async function montarManifesto(relatorio, decisoes, lote) {
  const conj = relatorio.conjuntos.filter(
    (c) => String(c.lote) === String(lote),
  );
  const porId = new Map(conj.map((c) => [c.word_id, c]));
  const decPorId = new Map();
  const fora = [];
  for (const d of decisoes) {
    if (!porId.has(d.word_id)) continue; // decisão de outro lote
    if (decPorId.has(d.word_id)) {
      fora.push({
        palavra: porId.get(d.word_id).palavra,
        motivo: "decisão repetida para a mesma palavra",
      });
      decPorId.set(d.word_id, null);
      continue;
    }
    decPorId.set(d.word_id, d);
  }
  const itens = [];
  for (const c of conj) {
    const d = decPorId.get(c.word_id);
    if (d === null) continue;
    if (!d || !d.decisao) {
      fora.push({ palavra: c.palavra, motivo: "sem decisão" });
      continue;
    }
    if (d.decisao !== "aprovar") {
      fora.push({
        palavra: c.palavra,
        motivo: `${d.decisao}${d.nota ? ` — ${d.nota}` : ""}`,
      });
      continue;
    }
    const h = await setHash(c.word_id, c.definicao, c.alternativas);
    if (d.hash !== h || c.hash !== h) {
      fora.push({
        palavra: c.palavra,
        motivo: "hash da decisão ≠ conjunto atual (revisou outra versão)",
      });
      continue;
    }
    if (c.bloqueia) {
      fora.push({
        palavra: c.palavra,
        motivo: `aprovado, mas com BLOQUEIA: ${c.alertas
          .filter((a) => a.nivel === "BLOQUEIA")
          .map((a) => a.codigo)
          .join(", ")}`,
      });
      continue;
    }
    itens.push({
      word_id: c.word_id,
      palavra: c.palavra.slice(0, 80),
      distractors: c.alternativas.map((x) => x.trim()),
      hash: h,
    });
  }
  const loteNum = /^\d+$/.test(String(lote)) ? Number(lote) : String(lote);
  const manifesto = { versao_hash: SET_HASH_VERSION, lote: loteNum, itens };
  if (itens.length) {
    const r = manifestSchema.safeParse(manifesto);
    if (!r.success)
      throw new Error(`manifesto inválido: ${r.error.issues[0]?.message}`);
  }
  return { manifesto, fora };
}
