// D1 — revisão editorial do modo escolha (/admin/daily-choices). Lógica com
// dependências injetadas (testável sem banco). Regras:
//  * o gerador só grava RASCUNHOS; aprovação é sempre um ato do revisor sobre
//    ids que ele escolheu (individual ou lote selecionado), nunca automática;
//  * aprovar re-valida o conteúdo ATUAL (validador + definição igual à revisada);
//    o banco confere de novo (daily_choice_admin_review);
//  * manifesto (lote revisado fora do painel): importação e aprovação conferem o
//    HASH de cada conjunto no servidor — nada diferente do revisado entra.
import { z } from "zod";
import {
  draftDistractors,
  prepareAcervo,
  validateChoiceSet,
  type AcervoWord,
  type Validation,
} from "./daily-choice-content";
import { HASH_RE, setHash } from "./daily-choice-manifest";

export const ADMIN_ONLY = "Acesso restrito a administradores.";
export const MAX_BATCH = 200;

export const listInput = z
  .object({
    status: z.enum(["rascunho", "aprovado", "reprovado"]),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();
export const poolInput = z
  .object({ limit: z.number().int().min(1).max(1000) })
  .strict();
export const draftsInput = z
  .object({
    rows: z
      .array(
        z
          .object({
            wordId: z.string().uuid(),
            distractors: z.array(z.string().trim().min(1).max(200)).length(3),
            // hash do conjunto REVISADO (manifesto): o servidor recalcula e recusa se divergir
            hash: z.string().regex(HASH_RE).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BATCH),
  })
  .strict();
export const reviewInput = z
  .object({
    wordIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH),
    status: z.enum(["aprovado", "reprovado", "rascunho"]),
    // aprovação por manifesto: id → hash revisado; quem divergir (ou faltar) não é aprovado
    expected: z
      .record(z.string().uuid(), z.string().regex(HASH_RE))
      .refine((r) => Object.keys(r).length <= MAX_BATCH)
      .optional(),
  })
  .strict();
export const idsInput = z
  .object({ wordIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH) })
  .strict();
export const editInput = z
  .object({
    wordId: z.string().uuid(),
    distractors: z.array(z.string().trim().min(1).max(200)).length(3),
  })
  .strict();

export type AdminItem = {
  word_id: string;
  word: string;
  truth: string;
  published: boolean;
  distractors: string[] | null;
  status: string | null;
  truth_changed: boolean;
};

const asWords = (v: unknown): AcervoWord[] =>
  (Array.isArray(v) ? v : []).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      word: String(r.word ?? ""),
      meaning: String(r.meaning ?? ""),
      classe: typeof r.classe === "string" ? r.classe : null,
      category: typeof r.category === "string" ? r.category : null,
    };
  });

/**
 * Rascunhos a partir do acervo — roda NO NAVEGADOR do revisor (o Worker só
 * entrega o acervo e grava): sem custo de CPU no servidor, determinístico, sem IA.
 */
export function buildDrafts(raw: unknown): {
  rows: Array<{ wordId: string; distractors: string[] }>;
  targets: number;
  semCandidatos: number;
} {
  const r = (raw ?? {}) as Record<string, unknown>;
  const targets = asWords(r.targets);
  const pool = asWords(r.pool);
  const prepared = prepareAcervo(pool);
  const rows: Array<{ wordId: string; distractors: string[] }> = [];
  let sem = 0;
  for (const t of targets) {
    const d = draftDistractors(t, pool, prepared);
    if (d) rows.push({ wordId: t.id, distractors: d });
    else sem++;
  }
  return { rows, targets: targets.length, semCandidatos: sem };
}

/**
 * Grava RASCUNHOS (nunca aprovados). O servidor não confia no navegador:
 * valida cada conjunto contra a definição ATUAL da palavra e grava o
 * resultado do validador junto (a aprovação exige validador OK).
 */
export async function saveDrafts(
  deps: {
    get: (ids: string[]) => Promise<AdminItem[]>;
    addDrafts: (
      rows: Array<{
        word_id: string;
        distractors: string[];
        validacao: Validation;
      }>,
    ) => Promise<number>;
  },
  input: z.infer<typeof draftsInput>,
): Promise<{
  received: number;
  inserted: number;
  invalid: number;
  skipped: number;
  divergent: number;
}> {
  const byId = new Map(
    (await deps.get(input.rows.map((x) => x.wordId))).map((it) => [
      it.word_id,
      it,
    ]),
  );
  const rows: Array<{
    word_id: string;
    distractors: string[];
    validacao: Validation;
  }> = [];
  let invalid = 0;
  let divergent = 0;
  for (const x of input.rows) {
    const it = byId.get(x.wordId);
    if (!it || !it.published || it.status) continue; // inexistente, não publicada ou já tem conjunto
    // manifesto: só grava se for EXATAMENTE o revisado (definição atual + estas 3 alternativas)
    if (
      x.hash &&
      (await setHash(x.wordId, it.truth, x.distractors)) !== x.hash
    ) {
      divergent++;
      continue;
    }
    const validacao = validateChoiceSet({
      word: it.word,
      truth: it.truth,
      distractors: x.distractors,
    });
    if (!validacao.ok) invalid++;
    rows.push({ word_id: x.wordId, distractors: x.distractors, validacao });
  }
  const inserted = rows.length ? await deps.addDrafts(rows) : 0;
  return {
    received: input.rows.length,
    inserted,
    invalid,
    skipped: input.rows.length - inserted,
    divergent,
  };
}

/** Aprovar/reprovar/voltar a rascunho SÓ os ids escolhidos pelo revisor. */
export async function reviewSets(
  deps: {
    get: (ids: string[]) => Promise<AdminItem[]>;
    review: (
      ids: string[],
      status: string,
    ) => Promise<{ updated: number; skipped: number }>;
  },
  input: z.infer<typeof reviewInput>,
): Promise<{
  updated: number;
  skipped: number;
  problems: Array<{ word_id: string; word: string; reasons: string[] }>;
}> {
  const ids = Array.from(new Set(input.wordIds));
  if (input.status !== "aprovado") {
    const r = await deps.review(ids, input.status);
    return { ...r, problems: [] };
  }
  const items = await deps.get(ids);
  const ok: string[] = [];
  const problems: Array<{ word_id: string; word: string; reasons: string[] }> =
    [];
  for (const it of items) {
    const reasons: string[] = [];
    if (!it.distractors || !it.status) reasons.push("sem conjunto");
    if (!it.published) reasons.push("palavra não publicada");
    if (it.truth_changed)
      reasons.push(
        "a definição mudou depois do rascunho: edite e salve de novo",
      );
    if (input.expected) {
      const exp = input.expected[it.word_id];
      if (!exp) reasons.push("fora do manifesto");
      else if (
        !it.distractors ||
        (await setHash(it.word_id, it.truth, it.distractors)) !== exp
      )
        reasons.push("conteúdo diferente do revisado (hash)");
    }
    if (it.distractors) {
      const v = validateChoiceSet({
        word: it.word,
        truth: it.truth,
        distractors: it.distractors,
      });
      for (const i of v.issues)
        reasons.push(
          `${i.index >= 0 ? `distrator ${i.index + 1}: ` : ""}${i.msg}`,
        );
    }
    if (reasons.length)
      problems.push({ word_id: it.word_id, word: it.word, reasons });
    else ok.push(it.word_id);
  }
  const missing = ids.length - items.length;
  const r = ok.length
    ? await deps.review(ok, "aprovado")
    : { updated: 0, skipped: 0 };
  return {
    updated: r.updated,
    skipped: ids.length - r.updated,
    problems:
      missing > 0
        ? [
            ...problems,
            {
              word_id: "",
              word: "",
              reasons: [`${missing} id(s) inexistente(s)`],
            },
          ]
        : problems,
  };
}

/** Edita os 3 distratores (volta a rascunho); grava o resultado do validador. */
export async function editSet(
  deps: {
    get: (ids: string[]) => Promise<AdminItem[]>;
    edit: (
      wordId: string,
      distractors: string[],
      validacao: Validation,
    ) => Promise<number>;
  },
  input: z.infer<typeof editInput>,
): Promise<{ updated: number; validacao: Validation }> {
  const [it] = await deps.get([input.wordId]);
  if (!it || !it.status) throw new Error("Conjunto não encontrado.");
  const distractors = input.distractors.map((d) => d.trim());
  const validacao = validateChoiceSet({
    word: it.word,
    truth: it.truth,
    distractors,
  });
  const updated = await deps.edit(input.wordId, distractors, validacao);
  return { updated, validacao };
}
