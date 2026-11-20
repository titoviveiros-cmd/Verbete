import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { wellFormedDefinition } from "@/lib/text-filter";
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
  claimOfflineBatch,
  claimSerial,
  generateOfflineDefinitions,
  laneSlotFor,
  OFFLINE_CLAIM_MAX,
  OFFLINE_CLAIM_RPC,
  OFFLINE_CLAIM_SPARE,
  OFFLINE_RESERVE_EXTRA,
  type OfflineLane,
  seededRng,
  truthGuard,
  truthIssue,
} from "../../../supabase/functions/bot-definitions/offline.ts";
import { pickReserves } from "../../../supabase/functions/bot-definitions-v2/reserves.ts";

// PR #62, R6 (12/11) — G3 OPÇÃO C: reserva atômica na memória da rodada.
// A função do banco offline_claim_defs (migration 20261112100000) serializa
// sala+rodada (advisory lock) e recusa o IGUAL ou PARECIDO (Dice > 0,5) com o
// que a rodada já gravou — inclusive por chamadas SIMULTÂNEAS que chegaram
// antes. `claimSerial` é a referência em JS (mesmas regras; a equivalência
// SQL × JS foi provada no Postgres isolado: pr62\r6\prova-pg.json).

vi.setConfig({ testTimeout: 120_000 });

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

type W = { word: string; meaning: string; category: string; classe: string };
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

describe("R6: claimSerial (referência da função do banco)", () => {
  it("recusa igual/parecido com a rodada e com o que já pegou; respeita `want`", () => {
    const served = ["vento que sopra do mar"];
    const norms = [
      "vento que sopra do mar", // igual à rodada
      "cesto de palha trancada",
      "cesto de palha trancado", // parecido com a anterior (aceita)
      "Texto Nao Normalizado", // fora do formato da edge
      "",
      "panela de barro usada para guardar banha",
      "roda de viola no terreiro",
      "algo que sobra",
    ];
    const r = claimSerial(served, norms, 3);
    expect(r.picked).toEqual([2, 6, 7]);
    expect(r.examined).toBe(7);
    expect(claimSerial(served, norms, 0).picked).toEqual([]);
    expect(claimSerial([], [], 3).picked).toEqual([]);
    // teto de 20 aceitas e 24 candidatas (o mesmo da função)
    const rl = seededRng("r6:many");
    const word = () =>
      Array.from(
        { length: 7 },
        () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(rl() * 26)],
      ).join("");
    const many = Array.from(
      { length: 40 },
      () => `${word()} ${word()} ${word()}`,
    );
    expect(claimSerial([], many, 99).picked.length).toBe(20);
    expect(Math.max(...claimSerial([], many, 20).picked)).toBeLessThanOrEqual(
      OFFLINE_CLAIM_MAX,
    );
  });

  it("Dice inteiro (4·|A∩B| > |A|+|B|) = dice() > 0,5 em pares reais do gerador", () => {
    const rng = seededRng("r6:dice");
    let pares = 0;
    for (let k = 0; k < 3000; k++) {
      const w = WORDS[Math.floor(rng() * WORDS.length)]!;
      const [a, b] = generateOfflineDefinitions({
        ...w,
        lane: "bots",
        count: 2,
        seed: `r6:d:${k}`,
      }).map(normTxt);
      if (!a || !b) continue;
      pares++;
      expect(claimSerial([a], [b], 1).picked.length === 0, `${a} ~ ${b}`).toBe(
        close(a, b),
      );
    }
    expect(pares).toBeGreaterThan(2500);
  });
});

describe("R6: claimOfflineBatch (cliente da RPC)", () => {
  const fake = (res: { data: unknown; error: unknown } | Error) => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      db: {
        rpc: (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return res instanceof Error
            ? Promise.reject(res)
            : Promise.resolve(res);
        },
      },
    };
  };
  const defs = ["Cesto de palha", "Roda de viola", "Vento do mar"];
  const room = "11111111-1111-4111-8111-111111111111";

  it("devolve SÓ as aceitas, na ordem, e manda o texto normalizado", async () => {
    const f = fake({ data: [1, 3], error: null });
    expect(await claimOfflineBatch(f.db, defs, 2, room, 4)).toEqual([
      "Cesto de palha",
      "Vento do mar",
    ]);
    expect(f.calls).toEqual([
      {
        fn: OFFLINE_CLAIM_RPC,
        args: {
          p_room: room,
          p_round: 4,
          p_norms: ["cesto de palha", "roda de viola", "vento do mar"],
          p_want: 2,
        },
      },
    ]);
    // tudo já servido na rodada = lote vazio (não volta ao lote inteiro)
    expect(
      await claimOfflineBatch(
        fake({ data: [], error: null }).db,
        defs,
        2,
        room,
        4,
      ),
    ).toEqual([]);
  });

  it("indisponível (erro, função ausente, exceção, retorno inválido) = null → caminho de antes", async () => {
    const bad: Array<{ data: unknown; error: unknown } | Error> = [
      {
        data: null,
        error: { code: "PGRST202", message: "function not found" },
      },
      { data: null, error: { code: "55P03" } },
      { data: { x: 1 }, error: null },
      { data: [0], error: null },
      { data: [4], error: null },
      { data: [1, 1], error: null },
      { data: [1.5], error: null },
      { data: [1, 2, 3], error: null }, // mais que `want`
      new Error("rede"),
    ];
    for (const r of bad)
      expect(await claimOfflineBatch(fake(r).db, defs, 2, room, 4)).toBeNull();
    // sem sala/rodada válidas ou sem candidatas: nem chama
    for (const [d, rm, rd] of [
      [defs, "", 4],
      [defs, room, -1],
      [defs, room, 1.5],
      [[], room, 4],
    ] as const) {
      const f = fake({ data: [1], error: null });
      expect(await claimOfflineBatch(f.db, d, 2, rm, rd)).toBeNull();
      expect(f.calls.length).toBe(0);
    }
    // teto de candidatas e de `want`
    const f = fake({ data: [], error: null });
    await claimOfflineBatch(
      f.db,
      Array.from({ length: 30 }, (_, i) => `texto ${i}`),
      50,
      room,
      1,
    );
    expect((f.calls[0]!.args.p_norms as string[]).length).toBe(
      OFFLINE_CLAIM_MAX,
    );
    expect(f.calls[0]!.args.p_want).toBe(20);
  });

  // R7 (12/11, staging isolado): só a espera da trava tinha limite
  // (lock_timeout 1,5 s no banco). RPC lenta por outro motivo (PostgREST,
  // rede, banco) segurava a edge pelo tempo todo — 3 s medidos — sem cair no
  // caminho B. Agora: prazo na edge, aborta o pedido e devolve null.
  it("RPC lenta (3 s) = null no prazo da edge (2 s) e o pedido é abortado → caminho B", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const db = {
        rpc: () => {
          const p = new Promise<{ data: unknown; error: unknown }>((r) =>
            setTimeout(() => r({ data: [1], error: null }), 3000),
          );
          return Object.assign(p, {
            abortSignal(s: AbortSignal) {
              s.addEventListener("abort", () => {
                aborted = true;
              });
              return p;
            },
          });
        },
      };
      let settled: unknown = "pendente";
      void claimOfflineBatch(db, defs, 2, room, 4).then((v) => {
        settled = v;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).toBe("pendente");
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBeNull();
      expect(aborted).toBe(true);
      // dentro do prazo continua valendo a resposta do banco
      let fast: unknown = "pendente";
      const quick = {
        rpc: () =>
          new Promise<{ data: unknown; error: unknown }>((r) =>
            setTimeout(() => r({ data: [2], error: null }), 1500),
          ),
      };
      void claimOfflineBatch(quick, defs, 2, room, 4).then((v) => {
        fast = v;
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(fast).toEqual(["Roda de viola"]);
      expect(vi.getTimerCount()).toBe(0); // prazo limpo, sem timer pendurado
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("R6: edges e migration (estrutura)", () => {
  const v2 = read("supabase/functions/bot-definitions-v2/index.ts");
  const v1 = read("supabase/functions/bot-definitions/index.ts");
  const mig = read("supabase/migrations/20261112100000_offline_claim_defs.sql");
  const rb = read("supabase/rollback/offline_claim_defs.sql");

  it("v2: reserva só no ramo do gerador; null = o caminho B de antes, intacto", () => {
    expect(v2.split("claimOfflineBatch(").length - 1).toBe(1);
    const iGen = v2.indexOf("if (suspended) {");
    const iOff = v2.indexOf("if (offlineGen) {", iGen);
    const iClaim = v2.indexOf("claimOfflineBatch(");
    expect(iOff).toBeGreaterThan(iGen);
    expect(iClaim).toBeGreaterThan(iOff);
    const branch = v2.slice(iClaim, v2.indexOf("// 1) Geração", iClaim));
    expect(branch).toMatch(
      /claimOfflineBatch\(\s*admin,\s*vetted,\s*count \+ OFFLINE_RESERVE_EXTRA,\s*roomId,\s*round,\s*\);\s*if \(batch === null\) \{/,
    );
    // o B continua dentro do fallback: releitura, lote, upsert, keepClaimed
    const fb = branch.slice(
      branch.indexOf("if (batch === null) {"),
      branch.indexOf("return json("),
    );
    expect(fb).toMatch(/\.from\("ai_served_defs"\)\s*\.select\("norm_text"\)/);
    expect(fb).toMatch(/batch = offlineServeBatch\(/);
    expect(fb).toMatch(/batch = keepClaimed\(batch, claimed\);/);
    // uma resposta só, mesmos campos
    expect(branch.split("fallbacks: batch,").length - 1).toBe(1);
  });

  it("v1: reserva só no ramo do gerador, com sala/rodada; null = caminho B; folga de candidatas", () => {
    expect(v1.split("claimOfflineBatch(").length - 1).toBe(1);
    const iGen = v1.indexOf("generateOfflineDefinitions(");
    expect(v1.indexOf("claimOfflineBatch(")).toBeGreaterThan(iGen);
    expect(v1).toMatch(
      /memRoomId && memRound !== null && vetted\.length > 0\s*\?\s*await claimOfflineBatch\(admin, vetted, count, memRoomId, memRound\)\s*:\s*null;\s*if \(offlineDefs === null\) \{/,
    );
    expect(v1).toContain(
      "count: count + OFFLINE_RESERVE_EXTRA + OFFLINE_CLAIM_SPARE,",
    );
    expect(OFFLINE_CLAIM_SPARE).toBe(4);
  });

  it("migration: trava por sala+rodada, Dice inteiro, uma gravação, só service_role; rollback", () => {
    expect(mig).toMatch(
      /CREATE OR REPLACE FUNCTION public\.offline_claim_defs\(\s*p_room uuid,\s*p_round integer,\s*p_norms text\[\],\s*p_want integer\s*\)/,
    );
    expect(mig).toContain("SECURITY INVOKER");
    expect(mig).not.toMatch(/SECURITY DEFINER/);
    expect(mig).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(mig).toContain("SET lock_timeout TO '1500ms'");
    expect(mig).toContain(
      "PERFORM pg_advisory_xact_lock(hashtext('verbete:offline-claim:' || p_room::text), p_round);",
    );
    expect(mig.split("PERFORM pg_advisory").length - 1).toBe(1); // uma trava só
    expect(mig).toContain("4 * x.c > v_sn[x.k] + cardinality(v_g)");
    expect(mig).toContain("ON CONFLICT (room_id, round, norm_text) DO NOTHING");
    expect(mig).toMatch(
      /IF v_n > 24 OR p_want < 0 OR p_want > 20 OR p_round < 0 THEN/,
    );
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.offline_claim_defs\(uuid, integer, text\[\], integer\) FROM PUBLIC;/,
    );
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.offline_claim_defs\(uuid, integer, text\[\], integer\) FROM anon, authenticated;/,
    );
    expect(mig).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.offline_claim_defs\(uuid, integer, text\[\], integer\) TO service_role;/,
    );
    // sem tabela nova, sem DROP/ALTER de nada que exista
    expect(mig.replace(/--.*$/gm, "")).not.toMatch(
      /CREATE TABLE|ALTER TABLE|DROP /i,
    );
    expect(rb).toMatch(
      /DROP FUNCTION IF EXISTS public\.offline_claim_defs\(uuid, integer, text\[\], integer\);/,
    );
  });
});

// --- Modelo das edges com a reserva (opção C): pedidos simultâneos ---
type Kind = "bots" | "robo" | "dica";
function candidates(
  kind: Kind,
  w: W,
  count: number,
  partida: string[],
  snapshot: string[],
  rng: () => number,
  seed: string,
  laneSlot?: number,
) {
  if (kind === "dica") {
    const gen = generateOfflineDefinitions({
      ...w,
      avoidRound: snapshot,
      lane: "dica",
      laneSlot,
      count: count + OFFLINE_RESERVE_EXTRA + OFFLINE_CLAIM_SPARE,
      seed,
    });
    return {
      want: count,
      list: dropAlreadyServed(
        dropNearTruth(dropMalformed(gen, w.word).kept, w.meaning).kept,
        snapshot,
      ).kept,
    };
  }
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
  return {
    want: count + OFFLINE_RESERVE_EXTRA,
    list: vetReserves(fila, {
      word: w.word,
      meaning: w.meaning,
      previous: partida,
      servedNorms: snapshot,
    }),
  };
}

/**
 * Pior caso: todas as chamadas da rodada GERAM com a mesma memória (vazia) e
 * nenhuma vê a gravação das outras; a RESERVA roda na ordem de chegada (o
 * banco serializa sala+rodada), contra o que já foi commitado.
 */
function piorComReserva(
  seed: string,
  humans: number,
  matches: number,
  rounds: number,
) {
  const rng = seededRng(seed);
  const sample = WORDS.filter((_, i) => i % 3 === 0);
  let total = 0;
  let anyClose = 0;
  let anyEqual = 0;
  let short = 0;
  let truth = 0;
  for (let m = 0; m < matches; m++) {
    const partida: string[] = [];
    for (let r = 0; r < rounds; r++) {
      total++;
      const w = sample[(m * 13 + r * 5) % sample.length]!;
      const calls: Array<{ kind: Kind; count: number; slot?: number }> = [
        { kind: "bots", count: 4 },
      ];
      for (let h = 0; h < humans; h++) {
        const slot = laneSlotFor(`tok:${seed}:${m}:${h}`);
        calls.push(
          { kind: "robo", count: 1, slot },
          { kind: "dica", count: 2, slot },
        );
      }
      const prepared = calls.map((c, i) => ({
        c,
        ...candidates(
          c.kind,
          w,
          c.count,
          partida,
          [],
          rng,
          `${seed}:${m}:${r}:${i}`,
          c.slot,
        ),
      }));
      prepared.sort(() => rng() - 0.5); // ordem de chegada no banco
      const served: string[] = [];
      const shown: string[] = [];
      for (const p of prepared) {
        const got = claimSerial(served, p.list.map(normTxt), p.want).picked.map(
          (i) => p.list[i - 1]!,
        );
        served.push(...got.map(normTxt));
        if (got.length < Math.min(p.want, 2)) short++;
        if (p.c.kind === "bots") {
          const rows: string[] = [];
          for (const t of got) {
            if (rows.length >= p.c.count) break;
            const ok = wellFormedDefinition(t, w.word);
            if (ok && !partida.some((x) => close(x, ok))) rows.push(ok);
          }
          shown.push(...rows);
          partida.push(...rows);
        } else if (p.c.kind === "robo") {
          const pick = [...got].sort(() => rng() - 0.5)[0];
          if (pick) shown.push(pick);
        } else shown.push(...got.slice(0, 2));
      }
      let cl = false;
      for (let i = 0; i < shown.length; i++)
        for (let j = i + 1; j < shown.length; j++) {
          if (normTxt(shown[i]!) === normTxt(shown[j]!)) anyEqual++;
          if (close(shown[i]!, shown[j]!)) cl = true;
        }
      if (cl) anyClose++;
      const g = truthGuard(w.meaning);
      for (const t of shown) if (truthIssue(t, g)) truth++;
    }
  }
  return { total, anyClose, anyEqual, short, truth };
}

describe("R6: G3 no pior caso simultâneo COM a reserva (opção C)", () => {
  it("2 humanos: rodadas com par parecido ≤ 1% e nenhum texto igual", () => {
    const r = piorComReserva("r6:pior:h2", 2, 20, 10);
    console.info(
      `[G3 pior, opção C, 2 humanos] rodadas=${r.total} parecidas=${r.anyClose} iguais=${r.anyEqual} curtas=${r.short} verdade=${r.truth}`,
    );
    expect(r.anyClose / r.total).toBeLessThanOrEqual(0.01);
    expect(r.anyEqual).toBe(0);
    expect(r.truth).toBe(0);
  });

  it("4 humanos: rodadas com par parecido ≤ 1% e nenhum texto igual", () => {
    const r = piorComReserva("r6:pior:h4", 4, 20, 10);
    console.info(
      `[G3 pior, opção C, 4 humanos] rodadas=${r.total} parecidas=${r.anyClose} iguais=${r.anyEqual} curtas=${r.short} verdade=${r.truth}`,
    );
    expect(r.anyClose / r.total).toBeLessThanOrEqual(0.01);
    expect(r.anyEqual).toBe(0);
    expect(r.truth).toBe(0);
  });
});
