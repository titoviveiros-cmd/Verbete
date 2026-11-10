// D1 — R6: não existe mais aprovação sem hash. O painel principal manda o hash do
// que exibiu; o servidor confere aqui (com motivo legível) e o banco confere de novo
// na mesma transação do UPDATE (daily_choice_admin_review_hashed, só RASCUNHO).
// A função antiga (daily_choice_admin_review) passa a só reprovar / voltar a rascunho.
import { describe, expect, it, vi } from "vitest";
import {
  SEM_HASH,
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
  word: `w${n}`,
  truth: TRUTH,
  published: true,
  distractors: [...BONS],
  status: "rascunho",
  truth_changed: false,
  ...over,
});
/** O que o painel exibiu → o hash que ele manda. */
const exibido = (n: number, distractors = BONS, truth = TRUTH) =>
  setHash(ID(n), truth, distractors);
const deps = (
  items: AdminItem[],
  banco?: (e: Record<string, string>) => number,
) => {
  const review = vi.fn(async (ids: string[]) => ({
    updated: ids.length,
    skipped: 0,
  }));
  const reviewHashed = vi.fn(async (e: Record<string, string>) => {
    const n = banco ? banco(e) : Object.keys(e).length;
    return { updated: n, skipped: Object.keys(e).length - n };
  });
  return { get: async () => items, review, reviewHashed };
};

describe("R6 — servidor: aprovar exige o hash do que foi exibido", () => {
  it("sem expected: recusa inteira, nada é gravado (painel antigo em cache)", async () => {
    const d = deps([item(1)]);
    await expect(
      reviewSets(d, { wordIds: [ID(1)], status: "aprovado" }),
    ).rejects.toThrow(SEM_HASH);
    await expect(
      reviewSets(d, {
        wordIds: [ID(1)],
        status: "aprovado",
        source: "painel",
      }),
    ).rejects.toThrow(SEM_HASH);
    expect(d.review).not.toHaveBeenCalled();
    expect(d.reviewHashed).not.toHaveBeenCalled();
  });

  it("hash do exibido = gravado → vai ao banco SÓ por reviewHashed, com o hash do exibido", async () => {
    const d = deps([item(1), item(2)]);
    const expected = { [ID(1)]: await exibido(1), [ID(2)]: await exibido(2) };
    const r = await reviewSets(d, {
      wordIds: [ID(1), ID(2)],
      status: "aprovado",
      expected,
      source: "painel",
    });
    expect(d.reviewHashed).toHaveBeenCalledWith(expected);
    expect(d.review).not.toHaveBeenCalled();
    expect(r).toEqual({ updated: 2, skipped: 0, problems: [] });
  });

  it("alternativa trocada depois de exibida → não aprova e explica", async () => {
    const outra = ["Ave pequena dos rios", BONS[1]!, BONS[2]!];
    const d = deps([item(1, { distractors: outra })]);
    const r = await reviewSets(d, {
      wordIds: [ID(1)],
      status: "aprovado",
      expected: { [ID(1)]: await exibido(1) },
      source: "painel",
    });
    expect(d.reviewHashed).not.toHaveBeenCalled();
    expect(r.updated).toBe(0);
    expect(r.problems[0]!.reasons).toContain(
      "mudou depois de exibido (hash): recarregue e confira de novo",
    );
  });

  it("definição trocada depois de exibida → não aprova", async () => {
    const d = deps([item(1, { truth: "outra definição qualquer" })]);
    const r = await reviewSets(d, {
      wordIds: [ID(1)],
      status: "aprovado",
      expected: { [ID(1)]: await exibido(1) },
      source: "painel",
    });
    expect(d.reviewHashed).not.toHaveBeenCalled();
    expect(r.problems[0]!.reasons.join()).toMatch(/mudou depois de exibido/);
  });

  it("ordem das alternativas faz parte do que foi visto", async () => {
    const d = deps([item(1)]);
    const r = await reviewSets(d, {
      wordIds: [ID(1)],
      status: "aprovado",
      expected: { [ID(1)]: await exibido(1, [BONS[1]!, BONS[0]!, BONS[2]!]) },
      source: "painel",
    });
    expect(d.reviewHashed).not.toHaveBeenCalled();
    expect(r.updated).toBe(0);
  });

  it("id selecionado sem hash → não aprova esse; os outros seguem", async () => {
    const d = deps([item(1), item(2)]);
    const r = await reviewSets(d, {
      wordIds: [ID(1), ID(2)],
      status: "aprovado",
      expected: { [ID(2)]: await exibido(2) },
      source: "painel",
    });
    expect(d.reviewHashed).toHaveBeenCalledWith({ [ID(2)]: await exibido(2) });
    expect(r.problems).toEqual([
      {
        word_id: ID(1),
        word: "w1",
        reasons: ["sem o hash do que foi exibido"],
      },
    ]);
  });

  it("hash de um id que NÃO foi selecionado não aprova nada a mais", async () => {
    const d = deps([item(1)]);
    await reviewSets(d, {
      wordIds: [ID(1)],
      status: "aprovado",
      expected: { [ID(1)]: await exibido(1), [ID(9)]: await exibido(9) },
      source: "painel",
    });
    expect(d.reviewHashed).toHaveBeenCalledWith({ [ID(1)]: await exibido(1) });
  });

  it("REPROVADO não é aprovado de uma vez: volta a rascunho antes", async () => {
    const d = deps([item(1, { status: "reprovado" })]);
    const r = await reviewSets(d, {
      wordIds: [ID(1)],
      status: "aprovado",
      expected: { [ID(1)]: await exibido(1) },
      source: "painel",
    });
    expect(d.reviewHashed).not.toHaveBeenCalled();
    expect(r.problems[0]!.reasons).toEqual([
      "reprovado: volte a rascunho antes de aprovar",
    ]);
  });

  it("já APROVADO: nada a fazer (não reescreve revisor nem data)", async () => {
    const d = deps([item(1, { status: "aprovado" })]);
    const r = await reviewSets(d, {
      wordIds: [ID(1)],
      status: "aprovado",
      expected: { [ID(1)]: await exibido(1) },
      source: "painel",
    });
    expect(d.reviewHashed).not.toHaveBeenCalled();
    expect(r.problems[0]!.reasons).toEqual(["já aprovado"]);
  });

  it("regras antigas continuam: definição mudada, não publicada, validador", async () => {
    const ruim = ["Ave pequena", BONS[1]!, BONS[2]!];
    const d = deps([
      item(1, { truth_changed: true }),
      item(2, { published: false }),
      item(3, { distractors: ruim }),
    ]);
    const r = await reviewSets(d, {
      wordIds: [ID(1), ID(2), ID(3)],
      status: "aprovado",
      expected: {
        [ID(1)]: await exibido(1),
        [ID(2)]: await exibido(2),
        [ID(3)]: await exibido(3, ruim),
      },
      source: "painel",
    });
    expect(d.reviewHashed).not.toHaveBeenCalled();
    expect(r.problems.map((p) => p.word_id)).toEqual([ID(1), ID(2), ID(3)]);
  });

  it("concorrência: alguém muda entre a conferência daqui e o UPDATE → o banco não aprova", async () => {
    // a conferência aqui passou; o banco (que recalcula o hash com a linha travada) recusou
    const d = deps([item(1), item(2)], (e) => Object.keys(e).length - 1);
    const r = await reviewSets(d, {
      wordIds: [ID(1), ID(2)],
      status: "aprovado",
      expected: { [ID(1)]: await exibido(1), [ID(2)]: await exibido(2) },
      source: "painel",
    });
    expect(r.updated).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("sem reviewHashed (servidor mal montado): falha em vez de aprovar sem hash", async () => {
    const review = vi.fn();
    await expect(
      reviewSets(
        { get: async () => [item(1)], review },
        {
          wordIds: [ID(1)],
          status: "aprovado",
          expected: { [ID(1)]: await exibido(1) },
          source: "painel",
        },
      ),
    ).rejects.toThrow(/sem hash/);
    expect(review).not.toHaveBeenCalled();
  });

  it("reprovar e voltar a rascunho seguem pela função antiga, sem hash", async () => {
    for (const status of ["reprovado", "rascunho"] as const) {
      const d = deps([item(1)]);
      await reviewSets(d, { wordIds: [ID(1)], status });
      expect(d.review).toHaveBeenCalledWith([ID(1)], status);
      expect(d.reviewHashed).not.toHaveBeenCalled();
    }
  });

  it("entrada: source só 'painel' ou 'manifesto'; campo desconhecido recusado", () => {
    const base = { wordIds: [ID(1)], status: "aprovado" as const };
    expect(() =>
      reviewInput.parse({ ...base, source: "painel" }),
    ).not.toThrow();
    expect(() =>
      reviewInput.parse({ ...base, source: "manifesto" }),
    ).not.toThrow();
    expect(() => reviewInput.parse({ ...base, source: "outro" })).toThrow();
    expect(() => reviewInput.parse({ ...base, semHash: true })).toThrow();
  });
});
