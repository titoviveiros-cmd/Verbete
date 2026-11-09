// D1 — manifesto de lote revisado: correspondência EXATA (hash) entre o revisado e o gravado/aprovado.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SET_HASH_VERSION,
  compareManifest,
  parseManifest,
  setHash,
  type Manifest,
} from "../daily-choice-manifest";
import {
  draftsInput,
  reviewInput,
  reviewSets,
  saveDrafts,
  type AdminItem,
} from "../daily-choice-admin";

const TRUTH = "Peixe de água doce, comum nos rios da Amazônia";
const BONS = [
  "Instrumento de corda usado em festas do sertão",
  "Doença de pele que causa coceira intensa",
  "Tecido grosso de algodão usado em velas",
];
const OUTRAS = [
  "Ave marinha de bico longo e penas escuras",
  "Doença de pele que causa coceira intensa",
  "Tecido grosso de algodão usado em velas",
];
const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n: number, over: Partial<AdminItem> = {}): AdminItem => ({
  word_id: ID(n),
  word: "acará",
  truth: TRUTH,
  published: true,
  distractors: BONS,
  status: "rascunho",
  truth_changed: false,
  ...over,
});
/** O MESMO cálculo do script offline de revisão (node:crypto). */
const hashNode = (id: string, truth: string, ds: string[]) =>
  createHash("sha256")
    .update(
      [SET_HASH_VERSION, id, truth, ...ds.map((d) => d.trim())].join("\n"),
      "utf8",
    )
    .digest("hex");

describe("hash do conjunto", () => {
  it("igual ao do script offline (Web Crypto × node:crypto), com trim nas alternativas", async () => {
    const h = await setHash(
      ID(1),
      TRUTH,
      BONS.map((b) => `  ${b} `),
    );
    expect(h).toBe(hashNode(ID(1), TRUTH, BONS));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("muda com a definição, com qualquer alternativa e com a ORDEM das alternativas", async () => {
    const base = await setHash(ID(1), TRUTH, BONS);
    expect(await setHash(ID(1), TRUTH + ".", BONS)).not.toBe(base);
    expect(await setHash(ID(1), TRUTH, OUTRAS)).not.toBe(base);
    expect(
      await setHash(ID(1), TRUTH, [BONS[1]!, BONS[0]!, BONS[2]!]),
    ).not.toBe(base);
    expect(await setHash(ID(2), TRUTH, BONS)).not.toBe(base);
  });
});

async function manifest(ns: number[], ds = BONS): Promise<Manifest> {
  return {
    versao_hash: SET_HASH_VERSION,
    lote: 1,
    itens: await Promise.all(
      ns.map(async (n) => ({
        word_id: ID(n),
        palavra: "acará",
        distractors: [...ds],
        hash: await setHash(ID(n), TRUTH, ds),
      })),
    ),
  };
}

describe("leitura do manifesto colado", () => {
  it("aceita o formato v1 e recusa JSON quebrado, versão errada, hash inválido e id repetido", async () => {
    const m = await manifest([1, 2]);
    expect(parseManifest(JSON.stringify(m))).toMatchObject({ ok: true });
    expect(parseManifest("{")).toEqual({
      ok: false,
      error: "Não é um JSON válido.",
    });
    expect(parseManifest(JSON.stringify({ ...m, versao_hash: "v0" })).ok).toBe(
      false,
    );
    expect(
      parseManifest(
        JSON.stringify({ ...m, itens: [{ ...m.itens[0], hash: "abc" }] }),
      ).ok,
    ).toBe(false);
    expect(
      parseManifest(JSON.stringify({ ...m, itens: [m.itens[0], m.itens[0]] }))
        .ok,
    ).toBe(false);
  });
});

describe("conferência manifesto × banco", () => {
  it("classifica cada palavra pelo estado REAL do banco", async () => {
    const m = await manifest([1, 2, 3, 4, 5, 6]);
    const rows = await compareManifest(m, [
      item(1, { status: null, distractors: null }), // sem conjunto → importar
      item(2), // gravado = revisado
      item(3, { distractors: OUTRAS }), // gravado ≠ revisado
      item(4, { truth: "Definição nova, alterada depois da revisão" }),
      item(5, { published: false }),
      // 6 não existe
    ]);
    expect(rows.map((r) => r.status)).toEqual([
      "importar",
      "identico",
      "divergente",
      "nao_confere",
      "nao_publicada",
      "inexistente",
    ]);
    expect(rows[1]!.estado).toBe("rascunho");
  });
  it("conjunto com a definição alterada depois do rascunho não conta como idêntico", async () => {
    const m = await manifest([1]);
    const [r] = await compareManifest(m, [item(1, { truth_changed: true })]);
    expect(r!.status).toBe("divergente");
  });
});

describe("servidor: importação confere o hash", () => {
  it("grava só o que bate com o revisado; conta os recusados", async () => {
    const addDrafts = vi.fn(async (rows: unknown[]) => rows.length);
    const ok = await setHash(ID(1), TRUTH, BONS);
    const r = await saveDrafts(
      {
        get: async () => [
          item(1, { status: null, distractors: null }),
          item(2, { status: null, distractors: null }),
        ],
        addDrafts,
      },
      {
        rows: [
          { wordId: ID(1), distractors: [...BONS], hash: ok },
          { wordId: ID(2), distractors: [...BONS], hash: ok }, // hash de OUTRA palavra
        ],
      },
    );
    const rows = (addDrafts.mock.calls[0] as unknown[])[0] as Array<{
      word_id: string;
    }>;
    expect(rows.map((x) => x.word_id)).toEqual([ID(1)]);
    expect(r).toMatchObject({
      received: 2,
      inserted: 1,
      divergent: 1,
      skipped: 1,
    });
  });
  it("entrada: hash opcional, mas se vier precisa ser SHA-256 hex", () => {
    expect(() =>
      draftsInput.parse({
        rows: [{ wordId: ID(1), distractors: [...BONS], hash: "x" }],
      }),
    ).toThrow();
  });
});

describe("servidor: aprovação por manifesto confere o hash", () => {
  it("aprova só os idênticos; recusa conteúdo diferente e ids fora do manifesto", async () => {
    const review = vi.fn(async (ids: string[]) => ({
      updated: ids.length,
      skipped: 0,
    }));
    const h1 = await setHash(ID(1), TRUTH, BONS);
    const h2 = await setHash(ID(2), TRUTH, BONS);
    const r = await reviewSets(
      {
        get: async () => [item(1), item(2, { distractors: OUTRAS }), item(3)],
        review,
      },
      {
        wordIds: [ID(1), ID(2), ID(3)],
        status: "aprovado",
        expected: { [ID(1)]: h1, [ID(2)]: h2 },
      },
    );
    expect(review).toHaveBeenCalledWith([ID(1)], "aprovado");
    expect(r.updated).toBe(1);
    expect(r.problems.map((p) => [p.word_id, p.reasons[0]])).toEqual([
      [ID(2), "conteúdo diferente do revisado (hash)"],
      [ID(3), "fora do manifesto"],
    ]);
  });
  it("sem manifesto, a aprovação segue como antes (sem exigir hash)", async () => {
    const review = vi.fn(async (ids: string[]) => ({
      updated: ids.length,
      skipped: 0,
    }));
    const r = await reviewSets(
      { get: async () => [item(1)], review },
      { wordIds: [ID(1)], status: "aprovado" },
    );
    expect(r.updated).toBe(1);
  });
  it("entrada: expected só com uuid → SHA-256 hex", () => {
    expect(() =>
      reviewInput.parse({
        wordIds: [ID(1)],
        status: "aprovado",
        expected: { x: "a".repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      reviewInput.parse({
        wordIds: [ID(1)],
        status: "aprovado",
        expected: { [ID(1)]: "zz" },
      }),
    ).toThrow();
    expect(
      reviewInput.parse({
        wordIds: [ID(1)],
        status: "aprovado",
        expected: { [ID(1)]: "a".repeat(64) },
      }),
    ).toBeTruthy();
  });
});
