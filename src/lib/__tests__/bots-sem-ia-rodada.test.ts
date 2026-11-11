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
  generateOfflineCandidates,
  generateOfflineDefinitions,
  laneOf,
  laneSlotFor,
  laneBucketOf,
  OFFLINE_LANE_BUCKETS,
  OFFLINE_LANE_SLOTS,
  slotBuckets,
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
// R4 (11/11 noite, G3 no pior caso simultâneo): dentro das faixas 🤖 e 💡,
//  cada jogador sorteia primeiro na SUA sub-faixa (hash do token da sessão);
//  faltando, a faixa inteira completa (e depois o banco, como antes).

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
  laneSlot?: number,
): Pending {
  if (kind === "dica") {
    // bot-definitions (v1): count + extra da sub-faixa/faixa das 💡 →
    // filtros → lote
    const gen = generateOfflineDefinitions({
      ...w,
      avoidRound: snapshot,
      lane: "dica",
      laneSlot,
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
    laneSlot: count === 1 ? laneSlot : undefined,
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
  slots?: Array<number | undefined>,
): RoundResult {
  const served: string[] = [];
  const calls: Array<{ kind: Kind; count: number; slot?: number }> = [
    { kind: "bots", count: nBots },
  ];
  // sub-faixa de cada humano = hash de um token sintético (como a edge faz
  // com o token da sessão); `slots` força valores (teste de sub-faixas)
  for (let h = 0; h < humans; h++) {
    const slot = slots ? slots[h] : laneSlotFor(`tok:${tag}:${h}`);
    // (slots com undefined = sem sub-faixa: o gerador fica idêntico ao R3)
    calls.push(
      { kind: "robo", count: 1, slot },
      { kind: "dica", count: 2, slot },
    );
  }
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
        edgeCall(
          c.kind,
          w,
          c.count,
          partida,
          [...served],
          rng,
          `${tag}:${i}`,
          c.slot,
        ),
      );
  } else {
    const fins = pend.map(({ c, i }) => ({
      c,
      i,
      fin: edgeCall(
        c.kind,
        w,
        c.count,
        partida,
        S0,
        rng,
        `${tag}:${i}`,
        c.slot,
      ),
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
    // R4: sub-faixa do jogador só no 🤖 e só dentro do if (offlineGen)
    expect(v2).toMatch(
      /laneSlot:\s*count === 1\s*\?\s*laneSlotFor\(bearerToken\(req\.headers\.get\("authorization"\)\)\)\s*:\s*undefined,/,
    );
    expect(v2.split("laneSlotFor(").length - 1).toBe(1);
    expect(v2.indexOf("laneSlotFor(")).toBeGreaterThan(
      v2.indexOf("if (offlineGen) {"),
    );
    expect(v2.indexOf("laneSlotFor(")).toBeLessThan(
      v2.indexOf("if (suspended) {"),
    );
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
    // R4: sub-faixa do jogador (só aqui, no ramo do gerador)
    expect(branch).toContain(
      'laneSlot: laneSlotFor(bearerToken(req.headers.get("authorization"))),',
    );
    expect(v1.split("laneSlotFor(").length - 1).toBe(1);
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

  // pior caso: todas as chamadas da rodada leem a memória juntas e nenhuma
  // releitura vê a gravação das outras. `slots` força as sub-faixas.
  const pior = (seed: string, slots?: Array<number | undefined>) => {
    const rng = seededRng(seed);
    let rounds = 0;
    let crossEqual = 0;
    let crossClose = 0;
    let anyEqual = 0;
    let anyClose = 0;
    for (let m = 0; m < 20; m++) {
      const partida: string[] = [];
      for (let r = 0; r < 10; r++) {
        rounds++;
        const w = sample[(m * 13 + r * 5) % sample.length]!;
        const res = playRound(
          w,
          4,
          2,
          partida,
          "pior",
          rng,
          `p:${m}:${r}`,
          slots,
        );
        const tagged = [
          ...res.bots.map((t) => ["bots", t] as const),
          ...res.robo.map((t) => ["robo", t] as const),
          ...res.dica.map((t) => ["dica", t] as const),
        ];
        let eq = false;
        let cl = false;
        let any = false;
        for (let i = 0; i < tagged.length; i++)
          for (let j = i + 1; j < tagged.length; j++) {
            // igual entre QUALQUER par (inclusive 🤖×🤖 e 💡×💡 de humanos diferentes)
            if (normTxt(tagged[i]![1]) === normTxt(tagged[j]![1])) anyEqual++;
            // parecido entre QUALQUER par (o G3 do simulador)
            if (close(tagged[i]![1], tagged[j]![1])) any = true;
            if (tagged[i]![0] === tagged[j]![0]) continue;
            if (normTxt(tagged[i]![1]) === normTxt(tagged[j]![1])) eq = true;
            else if (close(tagged[i]![1], tagged[j]![1])) cl = true;
          }
        if (eq) crossEqual++;
        if (cl) crossClose++;
        if (any) anyClose++;
        partida.push(...res.bots);
      }
    }
    return { rounds, crossEqual, crossClose, anyEqual, anyClose };
  };

  it("simultâneo (pior caso): faixas + sub-faixas + gravação atômica — nada IGUAL na rodada", () => {
    const r = pior("g3:pior");
    // mesma semente, sem sub-faixa (= gerador do R3, 907f4a2). Medido em
    // 11/11 noite: parecidos em qualquer par 84/200 sem → 74/200 com; iguais 0
    const r3 = pior("g3:pior", [undefined, undefined]);
    console.info(
      `[G3 pior, sem sub-faixa] rodadas=${r3.rounds} paresIguais=${r3.anyEqual} parecidosEntreTipos=${r3.crossClose} parecidosQualquerPar=${r3.anyClose}`,
    );
    console.info(
      `[G3 pior] rodadas=${r.rounds} iguais=${r.crossEqual} paresIguais=${r.anyEqual} parecidosEntreTipos=${r.crossClose} parecidosQualquerPar=${r.anyClose}`,
    );
    expect(r.crossEqual / r.rounds).toBeLessThanOrEqual(0.005);
    expect(r.anyEqual / r.rounds).toBeLessThanOrEqual(0.01);
    expect(r.crossClose / r.rounds).toBeLessThan(0.25);
    // parecidos em qualquer par (inclusive 🤖×🤖 e 💡×💡 de humanos diferentes)
    expect(r.anyClose).toBeLessThan(r3.anyClose);
    expect(r.anyEqual).toBeLessThanOrEqual(r3.anyEqual);
  });

  it("simultâneo (pior caso), humanos em sub-faixas diferentes: quase nada parecido", () => {
    const r = pior("g3:pior:distintas", [0, 10]); // pedaços 0-1 × 2-3
    // medido em 11/11 noite: 0 iguais; parecidos em qualquer par 27/200
    console.info(
      `[G3 pior, sub-faixas distintas] rodadas=${r.rounds} paresIguais=${r.anyEqual} parecidosQualquerPar=${r.anyClose}`,
    );
    expect(r.anyEqual / r.rounds).toBeLessThanOrEqual(0.01);
    expect(r.anyClose / r.rounds).toBeLessThan(0.25);
  });
});

describe("R4: sub-faixa por jogador nas faixas 🤖 e 💡", () => {
  it("laneSlotFor: estável, dentro do intervalo, vazio = sem sub-faixa, bem distribuído", () => {
    expect(OFFLINE_LANE_BUCKETS).toBe(6);
    expect(OFFLINE_LANE_SLOTS).toBe(30);
    expect(laneSlotFor("")).toBeUndefined();
    expect(laneSlotFor(null)).toBeUndefined();
    expect(laneSlotFor(undefined)).toBeUndefined();
    expect(laneSlotFor("abc.def.ghi")).toBe(laneSlotFor("abc.def.ghi"));
    // cada pedaço da faixa cabe a ~1/3 dos jogadores
    const n = new Array(OFFLINE_LANE_BUCKETS).fill(0);
    for (let i = 0; i < 6000; i++) {
      const s = laneSlotFor(`eyJ.sintetico.${i}`)!;
      expect(Number.isInteger(s) && s >= 0 && s < OFFLINE_LANE_SLOTS).toBe(
        true,
      );
      for (const b of slotBuckets(s)) n[b]++;
    }
    for (const c of n) {
      expect(c / 6000).toBeGreaterThan(0.28);
      expect(c / 6000).toBeLessThan(0.39);
    }
  });

  it("slotBuckets: 2 pedaços distintos; cada par aparece 2 vezes (mesma sub-faixa = 1 em 15)", () => {
    const pairs = new Map<string, number>();
    for (let s = 0; s < OFFLINE_LANE_SLOTS; s++) {
      const [a, b] = slotBuckets(s);
      expect(a).not.toBe(b);
      for (const x of [a, b])
        expect(x >= 0 && x < OFFLINE_LANE_BUCKETS).toBe(true);
      const k = [a, b].sort().join("-");
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
    expect(pairs.size).toBe(15);
    for (const c of pairs.values()) expect(c).toBe(2);
  });

  it("laneBucketOf não depende de laneOf: os trechos das faixas 🤖/💡 se espalham pelos pedaços", () => {
    const parts = [
      ...BANK.ADJ_QUE,
      ...BANK.ACTS,
      ...BANK.ADVERBS,
      ...BANK.QUEM,
    ];
    for (const lane of ["robo", "dica"] as const) {
      const mine = parts.filter((p) => laneOf(p) === lane);
      const n = new Array(OFFLINE_LANE_BUCKETS).fill(0);
      for (const p of mine) n[laneBucketOf(p)]++;
      for (const c of n) expect(c, `${lane}: ${n}`).toBeGreaterThan(0);
      expect(Math.max(...n) / mine.length, `${lane}: ${n}`).toBeLessThan(0.35);
    }
  });

  it("sem efeito fora das faixas 🤖/💡 ou com valor inválido (mesma saída de antes)", () => {
    const w = WORDS.find((x) => x.classe === "verbo")!;
    const base = { ...w, count: 6, seed: "r4:igual" };
    expect(
      generateOfflineDefinitions({ ...base, lane: "bots", laneSlot: 1 }),
    ).toEqual(generateOfflineDefinitions({ ...base, lane: "bots" }));
    expect(generateOfflineDefinitions({ ...base, laneSlot: 2 })).toEqual(
      generateOfflineDefinitions(base),
    );
    for (const bad of [-1, OFFLINE_LANE_SLOTS, 1.5, Number.NaN])
      expect(
        generateOfflineDefinitions({ ...base, lane: "robo", laneSlot: bad }),
      ).toEqual(generateOfflineDefinitions({ ...base, lane: "robo" }));
  });

  it("cada jogador sorteia primeiro na sua sub-faixa; faltando, a faixa completa", () => {
    const sample = WORDS.filter((x) =>
      ["verbo", "adjetivo", "advérbio"].includes(x.classe),
    );
    let total = 0;
    let own = 0;
    for (const [k, w] of sample.entries())
      for (const lane of ["robo", "dica"] as const)
        for (const s of [0, 7, 14, 21, 28]) {
          const count = lane === "robo" ? 6 : 4;
          const out = generateOfflineCandidates({
            ...w,
            lane,
            laneSlot: s,
            count,
            seed: `r4:${k}:${lane}:${s}`,
          });
          // nunca entrega menos do que sem a sub-faixa
          expect(out.length, w.word).toBeGreaterThanOrEqual(
            generateOfflineCandidates({
              ...w,
              lane,
              count,
              seed: `r4:${k}:${lane}:${s}`,
            }).length,
          );
          const mineB = slotBuckets(s);
          for (const c of out) {
            total++;
            if (mineB.includes(laneBucketOf(c.parts[0] ?? c.text))) own++;
          }
        }
    console.info(`[R4 sub-faixa] saídas=${total} na própria=${own}`);
    // medido em 11/11 noite: 2.242/2.600 = 86% na própria sub-faixa
    // o resto vem da faixa inteira (sub-faixa pequena): nunca falta
    expect(own / total).toBeGreaterThan(0.5);
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
