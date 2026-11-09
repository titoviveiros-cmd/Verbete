// D1 — endurecimento editorial (ressalvas R2, R3, R4 e R5 do PR #52).
// R1 (hash conferido dentro do banco) fica no PR da migration, à parte.
import { describe, expect, it, vi } from "vitest";
import {
  ALT_PROIBIDO,
  compareManifest,
  parseManifest,
  SET_HASH_VERSION,
  setHash,
  type Manifest,
} from "../daily-choice-manifest";
import {
  draftsInput,
  editInput,
  editSet,
  reviewSets,
  type AdminItem,
} from "../daily-choice-admin";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TRUTH = "Peixe de água doce, comum nos rios da Amazônia";
const BONS = [
  "Instrumento de corda usado em festas do sertão",
  "Doença de pele que causa coceira intensa",
  "Tecido grosso de algodão usado em velas",
];
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
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const LS = String.fromCharCode(0x2028);

describe("vetor fixo do hash v1 (o mesmo que o teste SQL do PR da migration usa)", () => {
  it("formato inalterado: os hashes já revisados continuam valendo", async () => {
    expect(SET_HASH_VERSION).toBe("verbete-d1-v1");
    expect(
      await setHash(ID(1), "perda ou diminuição dos movimentos voluntários", [
        "perda absoluta ou parcial da vontade",
        "aumento do volume de um órgão ou tecido",
        "contração muscular involuntária e visível sob a pele",
      ]),
    ).toBe("480b989b9cb845dd3a5e6baa9d9e3f9977fcd1b2e1dc99e06860ca79c89e1d5b");
  });
});

describe("R2: alternativa com quebra de linha ou caractere de controle é recusada", () => {
  it("a ambiguidade existe: definição e alternativas diferentes dariam o MESMO hash", async () => {
    // por isso a regra: sem quebra nas alternativas, as 3 últimas linhas são sempre elas
    const a = await setHash(ID(1), `x${NL}y`, ["c", "d", "e"]);
    const b = await setHash(ID(1), "x", ["y", "c", `d${NL}e`]);
    expect(a).toBe(b);
  });
  it.each([
    ["quebra de linha", `a${NL}b`],
    ["retorno de carro", `a${CR}b`],
    ["tabulação", `a${TAB}b`],
    ["separador de linha Unicode", `a${LS}b`],
  ])(
    "%s no meio: recusada no manifesto, na importação e na edição",
    (_n, ruim) => {
      const ds = [ruim, BONS[1]!, BONS[2]!];
      const m = {
        versao_hash: SET_HASH_VERSION,
        itens: [{ word_id: ID(1), distractors: ds, hash: "a".repeat(64) }],
      };
      const p = parseManifest(JSON.stringify(m));
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.error).toMatch(/quebra de linha/);
      expect(() =>
        draftsInput.parse({ rows: [{ wordId: ID(1), distractors: ds }] }),
      ).toThrow();
      expect(() =>
        editInput.parse({ wordId: ID(1), distractors: ds }),
      ).toThrow();
    },
  );
  it("espaço e quebra só nas pontas continuam aceitos (o trim já tirava; hash igual)", () => {
    const ds = [`  ${BONS[0]}${NL}`, BONS[1]!, BONS[2]!];
    expect(
      editInput.parse({ wordId: ID(1), distractors: ds }).distractors[0],
    ).toBe(BONS[0]);
  });
  it("texto comum com acento, travessão e aspas passa", () => {
    expect(ALT_PROIBIDO.test("ação — “pé” ‘ç’ ü")).toBe(false);
  });
  it("aprovação por manifesto recusa conjunto ANTIGO gravado com quebra de linha", async () => {
    const ruins = [`a${NL}b`, BONS[1]!, BONS[2]!];
    const review = vi.fn();
    const r = await reviewSets(
      { get: async () => [item(1, { distractors: ruins })], review },
      {
        wordIds: [ID(1)],
        status: "aprovado",
        expected: { [ID(1)]: await setHash(ID(1), TRUTH, ruins) },
      },
    );
    expect(review).not.toHaveBeenCalled();
    expect(r.problems[0]!.reasons).toContain(
      "alternativa gravada com quebra de linha: edite antes",
    );
  });
});

describe("R3: editar um APROVADO exige pedido explícito (o servidor recusa sem ele)", () => {
  it("sem allowApproved: nada é gravado e a resposta diz o motivo", async () => {
    const edit = vi.fn(async () => 1);
    const r = await editSet(
      { get: async () => [item(1, { status: "aprovado" })], edit },
      { wordId: ID(1), distractors: [...BONS] },
    );
    expect(r).toEqual({ updated: 0, validacao: null, blocked: "aprovado" });
    expect(edit).not.toHaveBeenCalled();
  });
  it("com allowApproved (editor do painel principal): grava e volta a rascunho", async () => {
    const edit = vi.fn(async () => 1);
    const r = await editSet(
      { get: async () => [item(1, { status: "aprovado" })], edit },
      { wordId: ID(1), distractors: [...BONS], allowApproved: true },
    );
    expect(r.updated).toBe(1);
    expect(r.blocked).toBeUndefined();
    expect(edit).toHaveBeenCalledTimes(1);
  });
  it.each(["rascunho", "reprovado"])(
    "%s continua editável sem pedido extra",
    async (st) => {
      const edit = vi.fn(async () => 1);
      const r = await editSet(
        { get: async () => [item(1, { status: st })], edit },
        { wordId: ID(1), distractors: [...BONS] },
      );
      expect(r.updated).toBe(1);
    },
  );
  it("entrada: allowApproved só aceita true (false não é um jeito de pedir)", () => {
    expect(() =>
      editInput.parse({
        wordId: ID(1),
        distractors: [...BONS],
        allowApproved: false,
      }),
    ).toThrow();
  });
});

describe("R4: aprovar por manifesto não desfaz uma reprovação", () => {
  it("com manifesto: REPROVADO idêntico é pulado com o motivo", async () => {
    const review = vi.fn(async (ids: string[]) => ({
      updated: ids.length,
      skipped: 0,
    }));
    const h = await setHash(ID(1), TRUTH, BONS);
    const h2 = await setHash(ID(2), TRUTH, BONS);
    const r = await reviewSets(
      {
        get: async () => [item(1, { status: "reprovado" }), item(2)],
        review,
      },
      {
        wordIds: [ID(1), ID(2)],
        status: "aprovado",
        expected: { [ID(1)]: h, [ID(2)]: h2 },
      },
    );
    expect(review).toHaveBeenCalledWith([ID(2)], "aprovado");
    expect(r.problems).toEqual([
      {
        word_id: ID(1),
        word: "acará",
        reasons: ["reprovado antes: reavalie no painel principal"],
      },
    ]);
  });
  it("sem manifesto (fluxo antigo, R6 em decisão): comportamento inalterado", async () => {
    const review = vi.fn(async (ids: string[]) => ({
      updated: ids.length,
      skipped: 0,
    }));
    const r = await reviewSets(
      { get: async () => [item(1, { status: "reprovado" })], review },
      { wordIds: [ID(1)], status: "aprovado" },
    );
    expect(r.updated).toBe(1);
  });
});

describe("R5: o rótulo diz o que se sabe (o hash não confere), não um palpite", () => {
  it("manifesto adulterado OU definição mudada → nao_confere", async () => {
    const h = await setHash(ID(1), TRUTH, BONS);
    const manifesto = (distractors: string[]): Manifest => ({
      versao_hash: SET_HASH_VERSION,
      itens: [{ word_id: ID(1), distractors, hash: h }],
    });
    const [adulterado] = await compareManifest(
      manifesto([BONS[0]!.slice(0, -1) + "X", BONS[1]!, BONS[2]!]),
      [item(1)],
    );
    const [definicaoNova] = await compareManifest(manifesto([...BONS]), [
      item(1, { truth: "outra definição" }),
    ]);
    expect(adulterado!.status).toBe("nao_confere");
    expect(definicaoNova!.status).toBe("nao_confere");
  });
});
