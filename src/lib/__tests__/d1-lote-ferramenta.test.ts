// Ferramenta offline de conferência de lotes do D1 (scripts/lib/d1-lote.mjs).
// Conteúdo sintético: nenhum conjunto real (as respostas ficam fora do Git).
import { describe, expect, it } from "vitest";
import {
  conferirLote,
  formatoTela,
  grafiaAntiga,
  lerAcervo,
  lerConjuntos,
  lerCsv,
  lerDecisoes,
  linhasRevisao,
  marcasPtPt,
  montarManifesto,
  paraCsv,
  setHash as setHashFerramenta,
  temaSensivel,
  COLUNAS_REVISAO,
  type Conjunto,
  type PalavraAcervo,
} from "../../../scripts/lib/d1-lote.mjs";
import { parseManifest, setHash } from "../daily-choice-manifest";
import { validateChoiceSet } from "../daily-choice-content";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const p = (
  n: number,
  word: string,
  meaning: string,
  extra: Partial<PalavraAcervo> = {},
): PalavraAcervo => ({
  id: id(n),
  word,
  meaning,
  classe: "substantivo",
  category: "literatura",
  rarity: 4,
  ...extra,
});

const ACERVO: PalavraAcervo[] = [
  p(1, "alfarrábio", "livro antigo, velho e de pouco valor"),
  p(2, "brochura", "livro de capa mole e costura simples"),
  p(3, "códice", "manuscrito antigo feito em cadernos"),
  p(4, "fólio", "folha numerada apenas na frente"),
  p(5, "glosa", "nota explicativa na margem do texto"),
  p(6, "alfarrábio", "sebo onde se vendem livros usados"), // outra entrada, mesma grafia
  p(7, "folhear", "virar as páginas de um livro", { classe: "verbo" }),
  p(8, "errata", "lista de erros corrigidos de uma obra"),
];
const M = Object.fromEntries(ACERVO.map((w) => [w.word + w.id.slice(-1), w]));
const A = M["alfarrábio1"]!;
const B = M["brochura2"]!;
const C = M["códice3"]!;
const D = M["fólio4"]!;

const conj = (o: Partial<Conjunto> & { word_id: string }): Conjunto => ({
  word: null,
  truth: null,
  distractors: [],
  hash: null,
  fontes: null,
  lote: "1",
  n: null,
  ...o,
});
const limpo = (o: Partial<Conjunto> = {}) =>
  conj({
    word_id: A.id,
    distractors: [B.meaning, C.meaning, D.meaning],
    ...o,
  });
const codigos = async (cs: Conjunto[], extra = {}) => {
  const r = await conferirLote(cs, { acervo: ACERVO, ...extra });
  return r.conjuntos.map((c) => c.alertas.map((a) => a.codigo));
};

describe("D1 lote — conferência offline", () => {
  it("conjunto limpo: PENDENTE (nunca 'aprovado'), hash = o do app, validador do app OK", async () => {
    const r = await conferirLote([limpo()], { acervo: ACERVO });
    const c = r.conjuntos[0]!;
    expect(c.alertas).toEqual([]);
    expect(c.status).toBe("PENDENTE");
    expect(c.hash).toBe(await setHash(A.id, A.meaning, c.alternativas));
    expect(setHashFerramenta).toBe(setHash);
    expect(
      validateChoiceSet({
        word: A.word,
        truth: A.meaning,
        distractors: c.alternativas,
      }).ok,
    ).toBe(true);
    expect(r.resumo.por_status).toEqual({ PENDENTE: 1 });
    expect(JSON.stringify(r)).not.toMatch(/aprovad/i);
  });

  it("BLOQUEIA o que o validador do app reprovaria (o banco nunca aprovaria)", async () => {
    const [c] = await codigos([
      limpo({ distractors: [A.meaning + " ", C.meaning, "livro"] }),
    ]);
    expect(c).toContain("validador");
    const r = await conferirLote(
      [limpo({ distractors: ["x", C.meaning, D.meaning] })],
      {
        acervo: ACERVO,
      },
    );
    expect(r.conjuntos[0]!.status).toBe("ALERTA");
    expect(r.conjuntos[0]!.bloqueia).toBeGreaterThan(0);
  });

  it("BLOQUEIA formato do manifesto: quebra de linha, 2 alternativas, id inválido", async () => {
    const cs = await codigos([
      limpo({
        distractors: [
          B.meaning,
          "manuscrito antigo\nfeito em cadernos",
          D.meaning,
        ],
      }),
      limpo({ word_id: id(1), distractors: [B.meaning, C.meaning] }),
      conj({
        word_id: "abc",
        word: "x",
        truth: "y",
        distractors: ["a", "b", "c"],
      }),
    ]);
    for (const c of cs) expect(c).toContain("formato");
  });

  it("BLOQUEIA hash do arquivo adulterado, definição diferente do acervo e palavra fora do acervo", async () => {
    const h = await setHash(A.id, A.meaning, [B.meaning, C.meaning, D.meaning]);
    const cs = await codigos([
      limpo({ hash: h.replace(/^./, h[0] === "a" ? "b" : "a") }),
      limpo({
        word_id: id(5),
        truth: "nota na margem",
        distractors: [B.meaning, C.meaning, D.meaning],
      }),
      conj({
        word_id: id(99),
        word: "zzz",
        truth: "algo qualquer aqui",
        distractors: [B.meaning, C.meaning, D.meaning],
      }),
    ]);
    expect(cs[0]).toContain("hash_arquivo");
    expect(cs[1]).toContain("definicao_mudou");
    expect(cs[2]).toContain("fora_do_acervo");
    const ok = await codigos([limpo({ hash: h })]);
    expect(ok[0]).toEqual([]);
  });

  it("BLOQUEIA palavra repetida, opções iguais na tela e outra acepção da mesma grafia", async () => {
    const [r1, r2] = await codigos([limpo(), limpo({ lote: "2" })]);
    expect(r1).toContain("palavra_repetida");
    expect(r2).toContain("palavra_repetida");
    const [tela] = await codigos([
      limpo({
        distractors: [
          B.meaning,
          "Livro de capa mole e costura simples.",
          D.meaning,
        ],
      }),
    ]);
    expect(tela).toContain("alternativas_iguais_na_tela");
    const [acep] = await codigos([
      limpo({ distractors: [M["alfarrábio6"]!.meaning, C.meaning, D.meaning] }),
    ]);
    expect(acep).toContain("outra_acepcao");
  });

  it("REVISAR: palavrão, palavra na certa, sinônimos registrados, sem fonte, classe", async () => {
    const sin = new Map([[A.id, ["brochura", "manuscrito"]]]);
    const extras = { sinonimos: sin, diario30: new Set([A.id]) };
    const [c] = await codigos([limpo()], { extras });
    expect(c).toEqual(
      expect.arrayContaining([
        "sinonimo_fonte",
        "contem_sinonimo",
        "diario_recente",
      ]),
    );
    const [pal] = await codigos([
      limpo({
        distractors: ["livro de capa mole e de merda", C.meaning, D.meaning],
      }),
    ]);
    expect(pal).toEqual(expect.arrayContaining(["palavrao", "sem_fonte"]));
    const acervo2 = ACERVO.map((w) =>
      w.id === A.id
        ? { ...w, meaning: "alfarrábios: livro antigo de pouco valor" }
        : w,
    );
    const r = await conferirLote([limpo()], { acervo: acervo2 });
    expect(r.conjuntos[0]!.alertas.map((a) => a.codigo)).toContain(
      "pista_palavra_na_certa",
    );
    const [cl] = await codigos([
      limpo({ distractors: [M["folhear7"]!.meaning, C.meaning, D.meaning] }),
    ]);
    expect(cl).toContain("classe_diferente");
  });

  it("REVISAR vazamento (alternativa = resposta de outro candidato) e repetição", async () => {
    const cs = await codigos([
      limpo(),
      conj({
        word_id: B.id,
        distractors: [A.meaning, M["glosa5"]!.meaning, M["errata8"]!.meaning],
      }),
      conj({
        word_id: D.id,
        distractors: [B.meaning, M["glosa5"]!.meaning, M["errata8"]!.meaning],
      }),
      conj({
        word_id: C.id,
        lote: "2",
        distractors: [B.meaning, M["glosa5"]!.meaning, M["errata8"]!.meaning],
      }),
    ]);
    expect(cs[1]).toContain("vazamento"); // A.meaning é a resposta do 1º
    expect(cs[1]).toContain("repetida_no_lote"); // glosa/errata também no 3º (mesmo lote)
    expect(cs[3]).not.toContain("repetida_no_lote"); // lote 2 sozinho
    expect(cs[3]).toContain("repetida_global"); // glosa em 3 conjuntos
  });

  it("REVISAR pistas de tamanho e de estilo", async () => {
    const acervo2 = ACERVO.map((w) =>
      w.id === A.id
        ? {
            ...w,
            meaning:
              "livro antigo, muito velho, gasto e de pouquíssimo valor comercial",
          }
        : w,
    );
    const r = await conferirLote([limpo()], { acervo: acervo2 });
    expect(r.conjuntos[0]!.alertas.map((a) => a.codigo)).toContain(
      "pista_tamanho",
    );
    const acervo3 = ACERVO.map((w) =>
      w.id === A.id
        ? { ...w, meaning: "livro antigo (velho) de pouco valor" }
        : w,
    );
    const r3 = await conferirLote([limpo()], { acervo: acervo3 });
    expect(r3.conjuntos[0]!.alertas.map((a) => a.codigo)).toContain(
      "pista_estilo",
    );
  });

  it("dúvidas editoriais viram alerta pelo nível; INFO não muda o status", async () => {
    const r = await conferirLote([limpo()], {
      acervo: ACERVO,
      duvidas: { alfarrábio: ["baixo", "conferido", "CONFERIDO", "FORTE"] },
    });
    expect(r.conjuntos[0]!.alertas.map((a) => a.codigo)).toEqual([
      "duvida_baixa",
    ]);
    expect(r.conjuntos[0]!.status).toBe("PENDENTE");
    const r2 = await conferirLote([limpo()], {
      acervo: ACERVO,
      duvidas: { alfarrábio: ["alto", "rejeitar", "SIGNIFICADO"] },
    });
    expect(r2.conjuntos[0]!.status).toBe("ALERTA");
  });

  it("detectores de texto e a formatação da tela (= daily_choice_fmt)", () => {
    expect(temaSensivel("pessoa que vende drogas")).toEqual(["droga"]);
    expect(temaSensivel("livro de capa mole")).toEqual([]);
    expect(marcasPtPt("o facto é que a equipa venceu")).toEqual([
      "facto",
      "equipa",
    ]);
    expect(grafiaAntiga("idéia de lingüiça e vôo")).toEqual([
      "trema",
      "éia/óia",
      "ôo",
    ]);
    expect(formatoTela("  livro antigo.;  ")).toBe("Livro antigo");
    expect(formatoTela("árvore: ")).toBe("Árvore");
  });
});

describe("D1 lote — arquivos", () => {
  it("lê o acervo no formato de `supabase db query -o json` e os lotes da revisão", () => {
    const raw = { boundary: "x", rows: [{ r: ACERVO }], warning: "w" };
    expect(lerAcervo(raw)).toHaveLength(ACERVO.length);
    const cs = lerConjuntos({
      lotes: [
        {
          lote: 3,
          conjuntos: [{ word_id: A.id, distractors: ["a", "b", "c"] }],
        },
      ],
    });
    expect(cs[0]!.lote).toBe("3");
    expect(cs[0]!.truth).toBeNull();
  });

  it("CSV: ida e volta com ; aspas, quebra de linha e BOM (Excel PT-BR)", () => {
    const csv = paraCsv(
      ["a", "b;c"],
      [
        ["x;y", 'diz "oi"'],
        ["linha\nnova", " borda "],
      ],
    );
    expect(csv.startsWith("﻿")).toBe(true);
    const rows = lerCsv(csv);
    expect(rows).toEqual([
      { a: "x;y", "b;c": 'diz "oi"' },
      { a: "linha\nnova", "b;c": " borda " },
    ]);
    expect(lerCsv("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("D1 lote — decisões → manifesto (nada é aprovado aqui)", () => {
  const preparar = async () => {
    const cs = [
      limpo(),
      conj({
        word_id: B.id,
        distractors: [M["glosa5"]!.meaning, C.meaning, D.meaning],
      }),
      conj({
        word_id: C.id,
        distractors: [B.meaning, M["errata8"]!.meaning, D.meaning],
      }),
      conj({ word_id: D.id, distractors: [B.meaning, "x", C.meaning] }), // BLOQUEIA (validador)
    ];
    return conferirLote(cs, { acervo: ACERVO });
  };

  it("planilha preenchida: só 'aprovar' com hash conferido e sem BLOQUEIA; passa no parseManifest do painel", async () => {
    const rel = await preparar();
    const linhas = linhasRevisao(rel.conjuntos);
    const iDec = COLUNAS_REVISAO.findIndex((c) => c.startsWith("DECISÃO"));
    const iHash = COLUNAS_REVISAO.indexOf("hash");
    linhas[0]![iDec] = "Aprovar";
    linhas[1]![iDec] = "rejeitar";
    linhas[2]![iDec] = "aprovar";
    linhas[2]![iHash] = "0".repeat(64); // revisou outra versão
    linhas[3]![iDec] = "aprovar";
    const dec = lerDecisoes(paraCsv(COLUNAS_REVISAO, linhas));
    const { manifesto, fora } = await montarManifesto(rel, dec, "1");
    expect(manifesto.itens.map((x) => x.word_id)).toEqual([A.id]);
    expect(manifesto.lote).toBe(1);
    expect(fora.map((f) => f.motivo).join(" | ")).toMatch(
      /rejeitar.*hash.*BLOQUEIA/,
    );
    const parsed = parseManifest(JSON.stringify(manifesto));
    expect(parsed.ok).toBe(true);
    expect(manifesto.itens[0]!.hash).toBe(
      await setHash(A.id, A.meaning, [B.meaning, C.meaning, D.meaning]),
    );
  });

  it("decisoes-d1.json da revisão em HTML; decisão repetida e outro lote ficam de fora", async () => {
    const rel = await preparar();
    const c0 = rel.conjuntos[0]!;
    const json = JSON.stringify({
      versao_hash: "verbete-d1-v1",
      itens: [
        {
          word_id: c0.word_id,
          palavra: c0.palavra,
          lote: 1,
          decisao: "aprovar",
          hash: c0.hash,
        },
        {
          word_id: c0.word_id,
          palavra: c0.palavra,
          lote: 1,
          decisao: "aprovar",
          hash: c0.hash,
        },
      ],
    });
    const { manifesto, fora } = await montarManifesto(
      rel,
      lerDecisoes(json),
      1,
    );
    expect(manifesto.itens).toEqual([]);
    expect(fora.some((f) => /repetida/.test(f.motivo))).toBe(true);
    const nada = await montarManifesto(rel, lerDecisoes(json), "2");
    expect(nada.manifesto.itens).toEqual([]);
  });
});
