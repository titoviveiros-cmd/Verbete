import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { definitionIssue, wellFormedDefinition } from "@/lib/text-filter";
import {
  dice,
  dropAlreadyServed,
  dropMalformed,
  dropNearTruth,
  MATCH_REPEAT_THRESHOLD,
  normTxt,
  vetReserves,
} from "../../../supabase/functions/bot-definitions/logic.ts";
import {
  generateOfflineDefinitions,
  laneOf,
  OFFLINE_MAX_CHARS,
  OFFLINE_MAX_WORDS,
  OFFLINE_RESERVE_EXTRA,
  type OfflineLane,
  offlineServeBatch,
  keepClaimed,
  seededRng,
  truthGuard,
  truthIssue,
} from "../../../supabase/functions/bot-definitions/offline.ts";
import * as BANK from "../../../supabase/functions/bot-definitions/offline-bank.ts";
import { pickReserves } from "../../../supabase/functions/bot-definitions-v2/reserves.ts";

// PR #62, rodada 11/11 (G3 e G7):
//  G3 — o 🤖 (count 1) sorteia entre as `fallbacks`, mas a edge gravava na
//       memória da rodada só as `count` primeiras: 91% das escolhas ficavam
//       fora e repetiam cédula de bot/💡. Agora a edge devolve count + 2,
//       grava TODAS (memória relida antes) e cada tipo de chamada sorteia
//       numa faixa própria do banco (pedidos simultâneos não se veem).
//  G7 — banco de adjetivos/verbos/advérbios ampliado; molde de adjetivo na
//       proporção do tamanho de cada lista.

vi.setConfig({ testTimeout: 120_000 });

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

type W = {
  word: string;
  meaning: string;
  category: string;
  classe: string;
};
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

const close = (a: string, b: string) => {
  const x = normTxt(a);
  const y = normTxt(b);
  return x === y || dice(x, y) > MATCH_REPEAT_THRESHOLD;
};

// --- Modelo fiel das duas edges no ramo "IA suspensa + gerador ligado" ---
type Kind = "bots" | "robo" | "dica";
type Pending = (servedNow: string[]) => string[];

function edgeCall(
  kind: Kind,
  w: W,
  count: number,
  partida: string[],
  snapshot: string[],
  rng: () => number,
  seed: string,
): Pending {
  if (kind === "dica") {
    // bot-definitions (v1): count + extra da faixa das 💡 → filtros → lote
    const gen = generateOfflineDefinitions({
      ...w,
      avoidRound: snapshot,
      lane: "dica",
      count: count + OFFLINE_RESERVE_EXTRA,
      seed,
    });
    const vetted = dropAlreadyServed(
      dropNearTruth(dropMalformed(gen, w.word).kept, w.meaning).kept,
      snapshot,
    ).kept;
    return (now) => offlineServeBatch(vetted, count, [...snapshot, ...now]);
  }
  // bot-definitions-v2: faixa por count, fila de 12 com as fixas, lote
  const lane: OfflineLane = count === 1 ? "robo" : "bots";
  const gen = generateOfflineDefinitions({
    ...w,
    avoid: partida,
    avoidRound: snapshot,
    lane,
    count: Math.min(12, count + OFFLINE_RESERVE_EXTRA + 3),
    seed,
  });
  const fila = [...gen, ...pickReserves(12, rng)].slice(0, 12);
  const vetted = vetReserves(fila, {
    word: w.word,
    meaning: w.meaning,
    previous: partida,
    servedNorms: snapshot,
  });
  return (now) =>
    offlineServeBatch(vetted, count + OFFLINE_RESERVE_EXTRA, [
      ...snapshot,
      ...now,
    ]);
}

type RoundResult = {
  bots: string[];
  robo: string[];
  dica: string[];
  roboRecorded: boolean[];
  short: number;
};

/**
 * Uma rodada: 1 chamada dos bots + (🤖 + 💡) por humano. `mode`:
 *  - "seq": uma depois da outra (cada uma vê o que as anteriores gravaram);
 *  - "pior": todas leem a memória ao mesmo tempo e nenhuma releitura vê a
 *    gravação das outras (o pior caso de pedidos simultâneos).
 */
function playRound(
  w: W,
  nBots: number,
  humans: number,
  partida: string[],
  mode: "seq" | "pior",
  rng: () => number,
  tag: string,
): RoundResult {
  const served: string[] = [];
  const calls: Array<{ kind: Kind; count: number }> = [
    { kind: "bots", count: nBots },
  ];
  for (let h = 0; h < humans; h++)
    calls.push({ kind: "robo", count: 1 }, { kind: "dica", count: 2 });
  const res: RoundResult = {
    bots: [],
    robo: [],
    dica: [],
    roboRecorded: [],
    short: 0,
  };
  const S0: string[] = [];
  const pend = calls.map((c, i) => {
    const snap = mode === "seq" ? null : S0;
    return { c, i, snap };
  });
  const run = (c: { kind: Kind; count: number }, i: number, fin: Pending) => {
    // upsert ON CONFLICT DO NOTHING + select (keepClaimed): o texto IGUAL que
    // outra chamada já gravou não fica no lote desta (gravação atômica)
    const lote = fin(mode === "seq" ? [...served] : S0);
    const have = new Set(served);
    const inserted = lote
      .map(normTxt)
      .filter((n, k, all) => !have.has(n) && all.indexOf(n) === k)
      .map((norm_text) => ({ norm_text }));
    // fiel à edge: retorno vazio = lote inteiro (nunca piora o de antes)
    const batch = keepClaimed(lote, inserted);
    served.push(...batch.map(normTxt));
    if (batch.length < Math.min(c.count, 2)) res.short++;
    if (c.kind === "bots") {
      // assembleBotRows: pula o que repete a partida; 1 por bot
      for (const t of batch) {
        if (res.bots.length >= nBots) break;
        const ok = wellFormedDefinition(t, w.word);
        if (ok && !partida.some((p) => close(p, ok))) res.bots.push(ok);
      }
    } else if (c.kind === "robo") {
      // generateAiDefinitionForPlayer: embaralha e pega a 1ª bem formada
      const pick = [...batch].sort(() => rng() - 0.5)[0];
      if (pick) {
        res.robo.push(pick);
        res.roboRecorded.push(batch.includes(pick));
      }
    } else res.dica.push(...batch.slice(0, 2));
    void i;
  };
  if (mode === "seq") {
    for (const { c, i } of pend)
      run(
        c,
        i,
        edgeCall(c.kind, w, c.count, partida, [...served], rng, `${tag}:${i}`),
      );
  } else {
    const fins = pend.map(({ c, i }) => ({
      c,
      i,
      fin: edgeCall(c.kind, w, c.count, partida, S0, rng, `${tag}:${i}`),
    }));
    fins.sort(() => rng() - 0.5);
    for (const { c, i, fin } of fins) run(c, i, fin);
  }
  return res;
}

describe("G3: lote da rodada (offlineServeBatch)", () => {
  it("no máximo `want`, sem o que a rodada já serviu e sem parecidas entre si", () => {
    const defs = [
      "cesto de palha trançada",
      "cesto de palha trançado",
      "panela de barro usada para guardar banha",
      "vento que sopra do mar",
      "roda de viola no terreiro",
    ];
    const served = [normTxt("vento que sopra do mar")];
    const out = offlineServeBatch(defs, 3, served);
    expect(out).toEqual([
      "cesto de palha trançada",
      "panela de barro usada para guardar banha",
      "roda de viola no terreiro",
    ]);
    expect(offlineServeBatch(defs, 0, [])).toEqual([]);
    expect(offlineServeBatch([], 3, served)).toEqual([]);
    expect(OFFLINE_RESERVE_EXTRA).toBe(2);
  });

  it("keepClaimed: fica só o que esta chamada gravou; retorno inútil = lote inteiro", () => {
    const lote = ["Cesto de palha", "roda de viola", "vento do mar"];
    expect(
      keepClaimed(lote, [
        { norm_text: "cesto de palha" },
        { norm_text: "vento do mar" },
      ]),
    ).toEqual(["Cesto de palha", "vento do mar"]);
    expect(keepClaimed(lote, null)).toEqual(lote);
    expect(keepClaimed(lote, [])).toEqual(lote);
    expect(keepClaimed(lote, { error: "x" })).toEqual(lote);
  });
});

describe("G3: edges — devolvem e gravam o MESMO lote; campos iguais (web e APK vc8)", () => {
  const v2 = read("supabase/functions/bot-definitions-v2/index.ts");
  const v1 = read("supabase/functions/bot-definitions/index.ts");

  it("v2: ramo sem IA relê a memória, devolve count + extra e grava o lote inteiro", () => {
    const iSusp = v2.indexOf("if (suspended) {");
    const branch = v2.slice(iSusp, v2.indexOf("// 1) Geração", iSusp));
    expect(branch).toMatch(/if \(offlineGen\) \{/);
    expect(branch).toMatch(
      /\.from\("ai_served_defs"\)\s*\.select\("norm_text"\)/,
    );
    expect(branch).toMatch(
      /offlineServeBatch\(\s*vetted,\s*count \+ OFFLINE_RESERVE_EXTRA,/,
    );
    expect(branch).toMatch(/servedRows\(batch, roomId, round\)/);
    expect(branch).toMatch(
      /ignoreDuplicates: true,\s*\}\)\s*\.select\("norm_text"\);\s*batch = keepClaimed\(batch, claimed\);/,
    );
    expect(branch).toMatch(/fallbacks: batch,/);
    // desligado: a resposta de sempre (as 12 vetadas, nada gravado)
    expect(branch).toMatch(/fallbacks: vetted,/);
    // mesmos campos nos dois caminhos
    for (const k of [
      "definitions: []",
      "personas: choosePersonas(count, body?.personas)",
      'gate: "skipped"',
    ])
      expect(branch.split(k).length - 1).toBe(2);
    // faixa por tipo de chamada
    expect(v2).toContain('lane: count === 1 ? "robo" : "bots",');
  });

  it("v1: faixa das 💡, memória relida e lote = o que é gravado e devolvido", () => {
    const iGen = v1.indexOf("generateOfflineDefinitions(");
    const branch = v1.slice(
      iGen,
      v1.indexOf(
        "return new Response(JSON.stringify({ definitions: [] })",
        iGen,
      ),
    );
    expect(branch).toContain('lane: "dica",');
    expect(branch).toMatch(
      /offlineServeBatch\(vetted, count, \[\.\.\.servedNorms, \.\.\.servedNow\]\)/,
    );
    expect(branch).toMatch(/servedRows\(offlineDefs, memRoomId, memRound\)/);
    expect(branch).toMatch(
      /offlineDefs = keepClaimed\(offlineDefs, claimed\);/,
    );
    expect(branch).toMatch(/JSON\.stringify\(\{ definitions: offlineDefs \}\)/);
  });
});

describe("G3: partidas simuladas (bots + 2 humanos com 🤖 e 💡)", () => {
  const sample = WORDS.filter((_, i) => i % 3 === 0);

  for (const rounds of [3, 10, 20]) {
    it(`sequencial, ${rounds} rodadas: 🤖 sempre na memória e nada parecido na rodada`, () => {
      const rng = seededRng(`g3:${rounds}`);
      for (let m = 0; m < 4; m++) {
        const partida: string[] = [];
        for (let r = 0; r < rounds; r++) {
          const w = sample[(m * 31 + r * 7) % sample.length]!;
          const res = playRound(
            w,
            4,
            2,
            partida,
            "seq",
            rng,
            `s${rounds}:${m}:${r}`,
          );
          expect(res.bots.length, w.word).toBe(4);
          expect(res.short, w.word).toBe(0);
          expect(res.roboRecorded.every(Boolean)).toBe(true);
          const shown = [...res.bots, ...res.robo, ...res.dica];
          for (let i = 0; i < shown.length; i++)
            for (let j = i + 1; j < shown.length; j++)
              expect(
                close(shown[i]!, shown[j]!),
                `${shown[i]} ~ ${shown[j]}`,
              ).toBe(false);
          // nada que toque a verdade em nenhum caminho
          const g = truthGuard(w.meaning);
          for (const t of shown)
            expect(truthIssue(t, g), `${w.word}: ${t}`).toBeNull();
          for (const b of res.bots)
            for (const p of partida)
              expect(close(b, p), `${b} ~ ${p}`).toBe(false);
          partida.push(...res.bots);
        }
      }
    });
  }

  it("simultâneo (pior caso): faixas + gravação atômica — nada IGUAL na rodada", () => {
    const rng = seededRng("g3:pior");
    let rounds = 0;
    let crossEqual = 0;
    let crossClose = 0;
    let anyEqual = 0;
    for (let m = 0; m < 20; m++) {
      const partida: string[] = [];
      for (let r = 0; r < 10; r++) {
        rounds++;
        const w = sample[(m * 13 + r * 5) % sample.length]!;
        const res = playRound(w, 4, 2, partida, "pior", rng, `p:${m}:${r}`);
        const tagged = [
          ...res.bots.map((t) => ["bots", t] as const),
          ...res.robo.map((t) => ["robo", t] as const),
          ...res.dica.map((t) => ["dica", t] as const),
        ];
        let eq = false;
        let cl = false;
        for (let i = 0; i < tagged.length; i++)
          for (let j = i + 1; j < tagged.length; j++) {
            // igual entre QUALQUER par (inclusive 🤖×🤖 e 💡×💡 de humanos diferentes)
            if (normTxt(tagged[i]![1]) === normTxt(tagged[j]![1])) anyEqual++;
            if (tagged[i]![0] === tagged[j]![0]) continue;
            if (normTxt(tagged[i]![1]) === normTxt(tagged[j]![1])) eq = true;
            else if (close(tagged[i]![1], tagged[j]![1])) cl = true;
          }
        if (eq) crossEqual++;
        if (cl) crossClose++;
        partida.push(...res.bots);
      }
    }
    // medido em 11/11: 0 iguais; parecidos (Dice > 0,5, outro trecho) ≈ 10%
    console.info(
      `[G3 pior] rodadas=${rounds} iguais=${crossEqual} paresIguais=${anyEqual} parecidosEntreTipos=${crossClose}`,
    );
    expect(crossEqual / rounds).toBeLessThanOrEqual(0.005);
    expect(anyEqual / rounds).toBeLessThanOrEqual(0.01);
    expect(crossClose / rounds).toBeLessThan(0.25);
  });
});

describe("Carga: pedidos concorrentes à função geradora", () => {
  it("2.000 pedidos intercalados = mesmos resultados que em série (sem estado compartilhado) e rápidos", async () => {
    const reqs = Array.from({ length: 2000 }, (_, i) => {
      const w = WORDS[(i * 7) % WORDS.length]!;
      const lanes: OfflineLane[] = ["bots", "robo", "dica"];
      return {
        ...w,
        lane: lanes[i % 3],
        count: i % 3 === 0 ? 7 : i % 3 === 1 ? 6 : 4,
        avoidRound: i % 5 === 0 ? ["cesto de palha trançada"] : [],
        seed: `carga:${i}`,
      };
    });
    const serial = reqs.map((r) => generateOfflineDefinitions(r));
    const times: number[] = [];
    const rng = seededRng("ordem");
    const order = reqs.map((_, i) => i).sort(() => rng() - 0.5);
    const conc: string[][] = new Array(reqs.length);
    await Promise.all(
      order.map(async (i) => {
        await new Promise((r) => setTimeout(r, Math.floor(rng() * 3)));
        const t0 = performance.now();
        conc[i] = generateOfflineDefinitions(reqs[i]!);
        times.push(performance.now() - t0);
      }),
    );
    expect(conc).toEqual(serial);
    for (const [i, out] of serial.entries())
      expect(out.length, `${reqs[i]!.word}`).toBeGreaterThanOrEqual(
        Math.min(reqs[i]!.count, 4),
      );
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    expect(p95).toBeLessThan(25);
  });
});

describe("G7: banco ampliado (adjetivos, verbos, advérbios)", () => {
  it("variedade por classe (3.000 pedidos de 3)", () => {
    const distinct = (w: W) => {
      const s = new Set<string>();
      for (let i = 0; i < 3000; i++)
        for (const d of generateOfflineDefinitions({
          ...w,
          count: 3,
          seed: `g7:${i}`,
        }))
          s.add(normTxt(d));
      return s.size;
    };
    // antes (a5bcb66): adjetivo 108, verbo 482, advérbio 161 (medido 11/11)
    expect(
      distinct({
        word: "lânguido",
        meaning: "sem forças, abatido",
        category: "qualidade",
        classe: "adjetivo",
      }),
    ).toBeGreaterThanOrEqual(500);
    expect(
      distinct({
        word: "cochilar",
        meaning: "dormir levemente",
        category: "",
        classe: "verbo",
      }),
    ).toBeGreaterThanOrEqual(600);
    expect(
      distinct({
        word: "devagar",
        meaning: "com lentidão",
        category: "",
        classe: "adverbio",
      }),
    ).toBeGreaterThanOrEqual(180);
  });

  it("faixas: ~10% 🤖, ~10% 💡, ~80% bots nos trechos do banco", () => {
    const parts = [
      ...BANK.ADJ_QUE,
      ...BANK.ACTS,
      ...BANK.ADVERBS,
      ...BANK.QUEM,
    ];
    const n = { bots: 0, robo: 0, dica: 0 };
    for (const p of parts) n[laneOf(p)]++;
    expect(n.robo / parts.length).toBeGreaterThan(0.04);
    expect(n.robo / parts.length).toBeLessThan(0.16);
    expect(n.dica / parts.length).toBeGreaterThan(0.04);
    expect(n.dica / parts.length).toBeLessThan(0.16);
  });

  it("cobertura editorial das combinações novas: forma, tamanho, 13+ e concordância", () => {
    const texts: string[] = [];
    for (const [verb, whens] of BANK.ADJ_MUDA)
      for (const w of whens) texts.push(`que ${verb} ${w}`);
    for (const [part, g] of BANK.ADJ_PARTES)
      for (const q of BANK.ADJ_PARTE_QUALS)
        texts.push(
          `que tem ${part} ${q.replace(/\{o\}/g, g === "f" ? "a" : "o")}`,
        );
    expect(texts.length).toBeGreaterThan(120);
    for (const t of texts) {
      expect(definitionIssue(t), t).toBeNull();
      expect(wellFormedDefinition(t, "zzz"), t).not.toBeNull();
      expect(normTxt(t).split(" ").length).toBeLessThanOrEqual(
        OFFLINE_MAX_WORDS,
      );
      expect(t.length).toBeLessThanOrEqual(OFFLINE_MAX_CHARS);
      // concordância: parte feminina nunca com adjetivo terminado em -o
      if (/^que tem a /.test(t)) expect(/o$/.test(t), t).toBe(false);
    }
    // nenhuma circunstância contraditória com o verbo (lista revisada)
    const BAD = [
      /amolece no frio/,
      /endurece no calor/,
      /esfria .*ao sol/,
      /embolora ao sol/,
    ];
    for (const t of texts)
      for (const re of BAD) expect(re.test(t), t).toBe(false);
  });
});
