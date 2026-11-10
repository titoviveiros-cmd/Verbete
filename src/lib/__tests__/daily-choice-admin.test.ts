// D1 — revisão editorial: rascunho automático, aprovação SÓ humana e re-validada.
import { describe, expect, it, vi } from "vitest";
import {
  draftsInput,
  editInput,
  editSet,
  buildDrafts,
  saveDrafts,
  reviewInput,
  reviewSets,
  type AdminItem,
} from "../daily-choice-admin";
import { setHash } from "../daily-choice-manifest";

const TRUTH = "Peixe de água doce, comum nos rios da Amazônia";
const BONS = [
  "Instrumento de corda usado em festas do sertão",
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

describe("gerador (no navegador do revisor) → servidor re-valida → só RASCUNHOS", () => {
  const POOL = {
    targets: [
      { id: ID(1), word: "acará", meaning: TRUTH, classe: "substantivo" },
      {
        id: ID(2),
        word: "zz",
        meaning:
          "Algo sem par no acervo de teste, com tamanho único e raro aqui",
        classe: null,
      },
    ],
    pool: [
      { id: ID(1), word: "acará", meaning: TRUTH, classe: "substantivo" },
      ...BONS.map((m, i) => ({
        id: ID(10 + i),
        word: `w${i}`,
        meaning: m,
        classe: "substantivo",
      })),
    ],
  };
  it("buildDrafts: rascunho para quem tem candidatos; conta os sem candidatos", () => {
    const d = buildDrafts(POOL);
    expect(d.targets).toBe(2);
    expect(d.semCandidatos).toBe(1);
    expect(d.rows).toEqual([{ wordId: ID(1), distractors: expect.any(Array) }]);
    expect(buildDrafts(null)).toEqual({
      rows: [],
      targets: 0,
      semCandidatos: 0,
    });
  });
  it("saveDrafts: re-valida contra a definição ATUAL; pula não publicada e quem já tem conjunto; nunca aprova", async () => {
    const addDrafts = vi.fn(async (rows: unknown[]) => rows.length);
    const r = await saveDrafts(
      {
        get: async () => [
          item(1, { status: null, distractors: null }),
          item(2, {
            status: null,
            distractors: null,
            truth: "Definição nova e bem diferente, que mudou depois",
          }),
          item(3, { status: null, distractors: null, published: false }),
          item(4), // já tem conjunto
        ],
        addDrafts,
      },
      {
        rows: [1, 2, 3, 4, 5].map((n) => ({
          wordId: ID(n),
          distractors: [...BONS],
        })),
      },
    );
    const rows = (addDrafts.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    expect(rows.map((x) => x.word_id)).toEqual([ID(1), ID(2)]);
    expect(rows[0]).toMatchObject({ validacao: { ok: true, issues: [] } });
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "distractors",
      "validacao",
      "word_id",
    ]); // nada de status: o banco grava 'rascunho'
    expect(r).toEqual({
      received: 5,
      inserted: 2,
      invalid: expect.any(Number),
      skipped: 3,
      divergent: 0,
    });
  });
  it("entrada: 1 a 200 linhas, 3 textos cada, sem campos extras", () => {
    expect(() => draftsInput.parse({ rows: [] })).toThrow();
    expect(() =>
      draftsInput.parse({
        rows: [{ wordId: ID(1), distractors: BONS.slice(0, 2) }],
      }),
    ).toThrow();
    expect(() =>
      draftsInput.parse({
        rows: [{ wordId: ID(1), distractors: [...BONS], status: "aprovado" }],
      }),
    ).toThrow();
  });
});

describe("aprovação: individual ou lote SELECIONADO, nunca automática", () => {
  it("aprova só os válidos (sempre por hash, R6); explica os pulados", async () => {
    const review = vi.fn(async (ids: string[]) => ({
      updated: ids.length,
      skipped: 0,
    }));
    const reviewHashed = vi.fn(async (e: Record<string, string>) => ({
      updated: Object.keys(e).length,
      skipped: 0,
    }));
    const it4 = ["Ave pequena", BONS[1]!, BONS[2]!];
    const expected = {
      [ID(1)]: await setHash(ID(1), TRUTH, BONS),
      [ID(2)]: await setHash(ID(2), TRUTH, BONS),
      [ID(3)]: await setHash(ID(3), TRUTH, BONS),
      [ID(4)]: await setHash(ID(4), TRUTH, it4),
    };
    const r = await reviewSets(
      {
        get: async () => [
          item(1),
          item(2, { word_id: ID(2), truth_changed: true }),
          item(3, { word_id: ID(3), published: false }),
          item(4, { word_id: ID(4), distractors: it4 }),
        ],
        review,
        reviewHashed,
      },
      {
        wordIds: [ID(1), ID(2), ID(3), ID(4), ID(1)],
        status: "aprovado",
        expected,
        source: "painel",
      },
    );
    expect(review).not.toHaveBeenCalled();
    expect(reviewHashed).toHaveBeenCalledWith({ [ID(1)]: expected[ID(1)] });
    expect(r.updated).toBe(1);
    expect(r.skipped).toBe(3);
    expect(r.problems.map((p) => p.word_id)).toEqual([ID(2), ID(3), ID(4)]);
  });
  it("reprovar/voltar a rascunho não passa pelo validador", async () => {
    const review = vi.fn(async () => ({ updated: 2, skipped: 0 }));
    const get = vi.fn();
    await reviewSets(
      { get, review },
      { wordIds: [ID(1), ID(2)], status: "reprovado" },
    );
    expect(get).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledWith([ID(1), ID(2)], "reprovado");
  });
  it("entrada: 1 a 200 ids explícitos; sem 'aprovar tudo'", () => {
    expect(() =>
      reviewInput.parse({ wordIds: [], status: "aprovado" }),
    ).toThrow();
    expect(() =>
      reviewInput.parse({
        wordIds: Array.from({ length: 201 }, (_, i) => ID(i)),
        status: "aprovado",
      }),
    ).toThrow();
    expect(() =>
      reviewInput.parse({ wordIds: [ID(1)], status: "aprovado", all: true }),
    ).toThrow();
    expect(() =>
      reviewInput.parse({ wordIds: ["nao-uuid"], status: "aprovado" }),
    ).toThrow();
  });
});

describe("edição", () => {
  it("valida contra a definição ATUAL e grava o resultado", async () => {
    const edit = vi.fn(async () => ({ updated: 1 }));
    const r = await editSet(
      { get: async () => [item(1)], edit },
      { wordId: ID(1), distractors: [" Ave pequena ", BONS[1]!, BONS[2]!] },
    );
    expect(r.validacao?.ok).toBe(false);
    expect(edit).toHaveBeenCalledWith(
      ID(1),
      ["Ave pequena", BONS[1]!, BONS[2]!],
      r.validacao,
      // sem pedido explícito: o banco recusa se estiver aprovado ou reprovado
      { approved: false, rejected: false },
    );
  });
  it("exige exatamente 3 textos", () => {
    expect(() =>
      editInput.parse({ wordId: ID(1), distractors: BONS.slice(0, 2) }),
    ).toThrow();
  });
});
