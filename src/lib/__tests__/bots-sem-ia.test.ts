import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  definitionIssue,
  revealsWord,
  textSimilarity,
  wellFormedDefinition,
} from "@/lib/text-filter";
import { BOT_FAKE_DEFINITIONS_TEMPLATES } from "@/lib/bot-names";
import {
  dice,
  dropAlreadyServed,
  LEAK_THRESHOLD,
  MATCH_REPEAT_THRESHOLD,
  normTxt,
  vetReserves,
} from "../../../supabase/functions/bot-definitions/logic.ts";
import {
  generateOfflineCandidates,
  generateOfflineDefinitions,
  inferWordClass,
  OFFLINE_GENERATOR_ENV,
  OFFLINE_MAX_CHARS,
  OFFLINE_MAX_WORDS,
  offlineGeneratorEnabled,
  semanticFields,
  truthGuard,
  truthIssue,
} from "../../../supabase/functions/bot-definitions/offline.ts";
import * as BANK from "../../../supabase/functions/bot-definitions/offline-bank.ts";

// Frente "bots sem IA externa" (10/11/2026): gerador local que substitui as
// 62 reservas fixas quando BOTS_OFFLINE_GENERATOR está ligado nas edges.

// suítes pesadas (10.800 definições): o padrão de 5 s não basta no CI
vi.setConfig({ testTimeout: 60_000 });

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

type W = { word: string; meaning: string; category: string; classe: string };
/** Acervo de teste = os seeds versionados (180 palavras curadas). */
const WORDS: W[] = (() => {
  const out: W[] = [];
  for (const f of [
    "supabase/migrations/20260713111000_words_seed_v2.sql",
    "supabase/migrations/20260721160000_words_seed_v3.sql",
  ]) {
    const re =
      /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*\d+\s*,\s*'((?:[^']|'')*)'/g;
    for (const m of read(f).matchAll(re))
      out.push({
        word: m[1]!.replace(/''/g, "'"),
        meaning: m[2]!.replace(/''/g, "'"),
        category: m[3]!,
        classe: m[4]!,
      });
  }
  return out;
})();

const gen = (w: W, seed: string, count = 3, avoid: string[] = []) =>
  generateOfflineDefinitions({ ...w, count, seed, avoid });

/** Todos os textos do banco (fragmentos), com {o} resolvido nos 2 gêneros. */
function bankStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(BANK);
  return out.flatMap((s) => [
    s.replace(/\{o\}/g, "o"),
    s.replace(/\{o\}/g, "a"),
  ]);
}

/** Termos sensíveis que o banco não pode ter (além dos palavrões do filtro). */
const SENSITIVE = [
  "sexo",
  "sexual",
  "droga",
  "maconha",
  "cocaina",
  "matar",
  "assassin",
  "suicid",
  "estupr",
  "arma",
  "faca de",
  "sangue",
  "nazis",
  "escrav",
  "macumb",
  "demonio",
  "diabo",
  "politic",
  "partido",
  "bolsonar",
  "lula",
  "cancer",
  "aids",
  "negro",
  "gordo",
  "aleijad",
  "retardad",
  "bunda",
  "peito nu",
];

describe("bots sem IA: interruptor explícito", () => {
  it("padrão desligado; só valores explícitos ligam", () => {
    expect(offlineGeneratorEnabled(() => undefined)).toBe(false);
    expect(offlineGeneratorEnabled(() => "")).toBe(false);
    expect(offlineGeneratorEnabled(() => "0")).toBe(false);
    expect(offlineGeneratorEnabled(() => "talvez")).toBe(false);
    for (const v of ["1", "true", "sim", "ligado", "gerador", " SIM "])
      expect(offlineGeneratorEnabled(() => v)).toBe(true);
    expect(OFFLINE_GENERATOR_ENV).toBe("BOTS_OFFLINE_GENERATOR");
  });

  it("edges: com o interruptor desligado, o caminho de sempre fica intacto", () => {
    const v2 = read("supabase/functions/bot-definitions-v2/index.ts");
    const v1 = read("supabase/functions/bot-definitions/index.ts");
    for (const s of [v1, v2]) {
      expect(s).toContain(
        "const offlineGen = offlineGeneratorEnabled((k) => Deno.env.get(k));",
      );
      // a consulta só muda com o interruptor ligado
      expect(s).toMatch(
        /offlineGen\s*\?\s*"word, meaning, category, classe, sinonimos"\s*:\s*"word, meaning, category"/,
      );
      expect(s.split("generateOfflineDefinitions(").length - 1).toBe(1);
    }
    // v2: reservas fixas continuam sendo a base; o gerador só entra sob o if
    expect(v2).toContain("let fallbacksIn = pickReserves(12);");
    const iIf = v2.indexOf("if (offlineGen) {");
    expect(iIf).toBeGreaterThan(0);
    expect(v2.indexOf("generateOfflineDefinitions(")).toBeGreaterThan(iIf);
    // ...e antes do ramo suspenso e do juiz (as duas leituras das reservas)
    expect(v2.indexOf("generateOfflineDefinitions(")).toBeLessThan(
      v2.indexOf("if (suspended) {"),
    );
    // v1: só dentro do ramo suspenso, e o retorno vazio de sempre continua
    const iSusp = v1.indexOf('=== "suspenso") {');
    const iGen = v1.indexOf("generateOfflineDefinitions(");
    expect(iGen).toBeGreaterThan(iSusp);
    expect(v1).toContain(
      "return new Response(JSON.stringify({ definitions: [] }), {",
    );
  });
});

describe("bots sem IA: conteúdo", () => {
  it("banco marcado como PENDENTE REVISÃO EDITORIAL", () => {
    expect(read("supabase/functions/bot-definitions/offline-bank.ts")).toMatch(
      /PENDENTE REVISÃO EDITORIAL/,
    );
  });

  it("nenhum trecho do banco tem palavrão, link ou termo sensível", () => {
    const all = bankStrings();
    expect(all.length).toBeGreaterThan(600);
    for (const s of all) {
      expect(definitionIssue(s), s).toBeNull();
      const n = normTxt(s);
      for (const bad of SENSITIVE)
        expect(` ${n}`.includes(` ${normTxt(bad)}`), `${s} ~ ${bad}`).toBe(
          false,
        );
    }
  });

  it("acervo de teste carregado (seeds v2+v3)", () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(150);
  });

  it("editorial 13+: sem álcool, golpe, doença, origem étnica nem fumo (Red Team 10/11)", () => {
    // só o conteúdo que vira texto (o mini-tesauro de proteção fica de fora:
    // ele PRECISA conhecer "licor"/"golpe" para barrar o blefe)
    const { SEMANTIC_FIELDS: _fields, ...content } = BANK;
    void _fields;
    const texts: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") texts.push(normTxt(v.replace(/\{o\}/g, "o")));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(content);
    // moldes escritos no próprio gerador
    texts.push(normTxt(read("supabase/functions/bot-definitions/offline.ts")));
    const BANNED = [
      "licor",
      "ferment",
      "vinho",
      "cachac",
      "cerveja",
      "aguardente",
      "golpe",
      "doenca cronica",
      "moura",
      "mouro",
      "fumo",
      "tabaco",
      "cigarr",
    ];
    for (const t of texts)
      for (const b of BANNED)
        expect(` ${t}`.includes(` ${b}`), `${t.slice(0, 60)} ~ ${b}`).toBe(
          false,
        );
  });
});

describe("bots sem IA: partida longa (Red Team 10/11 — banco se esgotava)", () => {
  // Advérbio, verbo e adjetivo de bancos pequenos: a MESMA classe em todas
  // as rodadas é o pior caso. Antes: 0 frases a partir da 6ª/7ª rodada.
  const LONG: W[] = [
    {
      word: "devagar",
      meaning: "com lentidão; sem pressa",
      category: "",
      classe: "adverbio",
    },
    {
      word: "cochilar",
      meaning: "dormir levemente, por pouco tempo",
      category: "",
      classe: "verbo",
    },
    {
      word: "barulhento",
      meaning: "que faz muito barulho; ruidoso",
      category: "",
      classe: "adjetivo",
    },
  ];

  it("20 rodadas (bots + 2 💡 por rodada): nunca devolve lista vazia nem repete a rodada", () => {
    for (const w of LONG) {
      const guard = truthGuard(w.meaning);
      const partida: string[] = [];
      for (let round = 1; round <= 20; round++) {
        const rodada: string[] = [];
        const take = (defs: string[], want: number, tag: string) => {
          expect(
            defs.length,
            `${w.word} rodada ${round} ${tag}`,
          ).toBeGreaterThanOrEqual(want);
          for (const d of defs) {
            // a rodada é dura: nada parecido com o que ela já serviu
            for (const r of rodada)
              expect(
                dice(d, r),
                `${w.word} r${round}: ${d} ~ ${r}`,
              ).toBeLessThanOrEqual(MATCH_REPEAT_THRESHOLD);
            // e a verdade continua protegida em todos os níveis
            expect(truthIssue(d, guard), `${w.word}: ${d}`).toBeNull();
            expect(definitionIssue(d, w.word), d).toBeNull();
          }
        };
        // bots (v2): fila de 12, os 3 primeiros vão à mesa
        const fila = generateOfflineDefinitions({
          ...w,
          count: 12,
          seed: `longa:${round}`,
          avoid: partida,
          avoidRound: rodada,
        });
        take(fila, 3, "bots");
        rodada.push(...fila.slice(0, 3));
        // 💡 (v1): 3 por chamada, duas chamadas por rodada
        for (let h = 0; h < 2; h++) {
          const dicas = dropAlreadyServed(
            generateOfflineDefinitions({
              ...w,
              count: 3,
              seed: `longa:${round}:${h}`,
              avoid: partida,
              avoidRound: rodada,
            }),
            rodada.map(normTxt),
          ).kept;
          take(dicas, 3, `💡${h}`);
          rodada.push(...dicas);
        }
        partida.push(...rodada);
      }
    }
  });

  it("os níveis só relaxam quando falta: partida curta = filtro estrito de sempre", () => {
    const w = LONG[0]!;
    const partida: string[] = [];
    for (let round = 1; round <= 4; round++) {
      const defs = generateOfflineDefinitions({
        ...w,
        count: 3,
        seed: `curta:${round}`,
        avoid: partida,
      });
      expect(defs.length).toBe(3);
      for (const d of defs)
        for (const p of partida)
          expect(dice(d, p), `${d} ~ ${p}`).toBeLessThanOrEqual(
            MATCH_REPEAT_THRESHOLD,
          );
      partida.push(...defs);
    }
  });

  it("'devagar' nunca recebe 'vagaroso'/'lento' de blefe (campo lentidão)", () => {
    const w = LONG[0]!;
    for (let i = 0; i < 200; i++)
      for (const d of gen(w, `lento${i}`, 3)) {
        expect(semanticFields(d).has("lentidao"), d).toBe(false);
        expect(/\b(vagaros|lent)/.test(normTxt(d)), d).toBe(false);
      }
  });
});

describe("bots sem IA: qualidade das definições", () => {
  // 180 palavras × 20 sementes × 3 = 10.800 definições
  const ALL = WORDS.flatMap((w) =>
    Array.from({ length: 20 }, (_, i) => ({ w, defs: gen(w, `q${i}`) })),
  );

  it("sempre entrega o pedido (3 por chamada; 12 para a fila dos bots)", () => {
    for (const { w, defs } of ALL) expect(defs.length, w.word).toBe(3);
    for (const w of WORDS) expect(gen(w, "fila", 12).length, w.word).toBe(12);
  });

  it("forma, tamanho e filtro do jogador: tudo pronto para a mesa", () => {
    const lens: number[] = [];
    for (const { w, defs } of ALL)
      for (const d of defs) {
        expect(
          wellFormedDefinition(d, w.word),
          `${w.word}: ${d}`,
        ).not.toBeNull();
        expect(definitionIssue(d, w.word), d).toBeNull();
        const words = normTxt(d).split(" ").length;
        expect(words).toBeGreaterThanOrEqual(3);
        expect(words).toBeLessThanOrEqual(OFFLINE_MAX_WORDS);
        expect(d.length).toBeLessThanOrEqual(OFFLINE_MAX_CHARS);
        lens.push(d.length);
      }
    lens.sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)]!;
    // perto das definições reais (mediana 34) — as 62 fixas têm ~42
    expect(median).toBeGreaterThanOrEqual(24);
    expect(median).toBeLessThanOrEqual(44);
  });

  it("nunca revela a definição verdadeira (lexical, raiz e campo semântico)", () => {
    for (const { w, defs } of ALL)
      for (const d of defs) {
        expect(revealsWord(d, w.word), d).toBe(false);
        expect(dice(d, w.meaning), `${w.word}: ${d}`).toBeLessThan(
          LEAK_THRESHOLD,
        );
        expect(
          truthIssue(d, truthGuard(w.meaning)),
          `${w.word}: ${d}`,
        ).toBeNull();
        expect(normTxt(d)).not.toBe(normTxt(w.meaning));
      }
  });

  it("campo semântico: 'alvoroço' não recebe 'barulho'/'ruído' de blefe", () => {
    const w = {
      word: "zoeira",
      meaning: "alvoroço, gritaria",
      category: "regional",
      classe: "substantivo",
    };
    const g = truthGuard(w.meaning);
    expect(g.fields.has("barulho")).toBe(true);
    for (let i = 0; i < 200; i++)
      for (const d of gen(w, `campo${i}`)) {
        expect(semanticFields(d).has("barulho"), d).toBe(false);
      }
    // Red Team: "taramela" (tranca de porta) nunca recebe "prende a porteira"
    const tara = {
      word: "taramela",
      meaning: "peça giratória que tranca portas; tagarela",
      category: "objeto",
      classe: "substantivo",
    };
    for (let i = 0; i < 200; i++)
      for (const d of gen(tara, `tara${i}`)) {
        expect(semanticFields(d).has("fecho"), d).toBe(false);
      }
    // sinônimos cadastrados também protegem
    expect(
      truthIssue("gosto de ferrugem na água", truthGuard("x", ["ferrugem"])),
    ).toBe("stem");
  });

  it("coerência de classe (verbo → infinitivo; adjetivo → qualidade; substantivo → coisa)", () => {
    const INF = /^[a-zà-ú-]+(ar|er|ir|or|ôr)(-se)?,?$/;
    const ADJ_OPEN = /^(que|relativo|proprio|tipico|diz|cheio)$/;
    for (const w of WORDS) {
      const klass = inferWordClass(w);
      for (let i = 0; i < 10; i++)
        for (const c of generateOfflineCandidates({
          ...w,
          count: 3,
          seed: `c${i}`,
        })) {
          const first = normTxt(c.text).split(" ")[0]!;
          if (klass === "verbo") {
            expect(c.via.startsWith("verbo"), c.text).toBe(true);
            expect(
              INF.test(c.text.split(" ")[0]!.toLowerCase()) ||
                first === "tornar",
              c.text,
            ).toBe(true);
          } else if (klass === "adjetivo") {
            expect(c.via.startsWith("adj"), c.text).toBe(true);
            if (c.via !== "adj-par")
              expect(ADJ_OPEN.test(first), c.text).toBe(true);
          } else if (klass === "adverbio") {
            expect(c.via).toBe("adverbio");
          } else {
            expect(
              c.via.startsWith("verbo") || c.via.startsWith("adj"),
              c.text,
            ).toBe(false);
            expect(first, c.text).not.toBe("que");
          }
        }
    }
    expect(inferWordClass({ word: "farfalhar", classe: "verbo" })).toBe(
      "verbo",
    );
    expect(inferWordClass({ word: "lauto", classe: "adjetivo" })).toBe(
      "adjetivo",
    );
    expect(inferWordClass({ word: "outrossim", classe: "advérbio" })).toBe(
      "adverbio",
    );
    // sem classe (palavra criada na sala): terminação
    expect(inferWordClass({ word: "rebimbar", category: "custom" })).toBe(
      "verbo",
    );
    expect(inferWordClass({ word: "pegajoso", category: "custom" })).toBe(
      "adjetivo",
    );
    expect(inferWordClass({ word: "bodoque", category: "custom" })).toBe(
      "substantivo",
    );
  });

  it("morfologia: -logia, -ite, -ção e -vel usam o molde do sufixo", () => {
    const vias = (word: string, classe: string) =>
      new Set(
        Array.from({ length: 40 }, (_, i) =>
          generateOfflineCandidates({
            word,
            meaning: "zzz qqq",
            category: "",
            classe,
            count: 3,
            seed: `m${i}`,
          }),
        )
          .flat()
          .map((c) => c.via),
      );
    expect(vias("ondulogia", "substantivo").has("sufixo-logia")).toBe(true);
    expect(vias("tarsite", "substantivo").has("sufixo-ite")).toBe(true);
    expect(vias("arrumação", "substantivo").has("sufixo-acao")).toBe(true);
    expect(vias("dobrável", "adjetivo").has("adj-pode")).toBe(true);
  });
});

describe("bots sem IA: variedade, repetição e determinismo", () => {
  const sample = WORDS.filter((_, i) => i % 6 === 0); // 30 palavras

  it("variedade: muito mais definições distintas que as 62 fixas", () => {
    const distinct = new Set<string>();
    let total = 0;
    for (const w of sample)
      for (let i = 0; i < 30; i++)
        for (const d of gen(w, `v${i}`)) {
          distinct.add(normTxt(d));
          total++;
        }
    // 2.700 definições: ≥ 10× as 62 fixas em textos distintos
    expect(total).toBe(2700);
    expect(distinct.size).toBeGreaterThanOrEqual(620);
    expect(BOT_FAKE_DEFINITIONS_TEMPLATES.length).toBe(62);
    // por palavra: 30 chamadas × 3 = 90 → ≥ 30 distintas
    for (const w of sample) {
      const per = new Set(
        Array.from({ length: 30 }, (_, i) => gen(w, `v${i}`)).flat(),
      );
      expect(per.size, w.word).toBeGreaterThanOrEqual(30);
    }
  });

  it("partida de 10 rodadas com 3 bots: nenhuma repetição nem trecho reaproveitado", () => {
    for (const [mi, w0] of sample.entries()) {
      const previous: string[] = [];
      for (let round = 1; round <= 10; round++) {
        const w = WORDS[(mi * 7 + round * 13) % WORDS.length]!;
        void w0;
        const fila = vetReserves(gen(w, `sala${mi}:${round}`, 12, previous), {
          word: w.word,
          meaning: w.meaning,
          previous,
          servedNorms: [],
        });
        const bots = fila.slice(0, 3);
        expect(bots.length).toBe(3);
        for (const b of bots) {
          const n = normTxt(b);
          for (const p of previous) {
            expect(dice(n, normTxt(p)), `${b} ~ ${p}`).toBeLessThanOrEqual(
              MATCH_REPEAT_THRESHOLD,
            );
          }
        }
        // entre os bots da mesma rodada também
        for (let i = 0; i < 3; i++)
          for (let j = i + 1; j < 3; j++)
            expect(textSimilarity(bots[i]!, bots[j]!)).toBeLessThanOrEqual(0.6);
        previous.push(...bots);
      }
    }
  });

  it("determinismo: mesma semente → mesma saída; semente nova → outra saída", () => {
    const w = WORDS[3]!;
    expect(gen(w, "abc", 6)).toEqual(gen(w, "abc", 6));
    expect(gen(w, "abc", 6)).not.toEqual(gen(w, "abd", 6));
  });

  it("desempenho: 1.000 pedidos de 12 em menos de 5 s", () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) gen(WORDS[i % WORDS.length]!, `p${i}`, 12);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
