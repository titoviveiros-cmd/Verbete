// D1 — revisão editorial do modo escolha (/admin/daily-choices). Lógica com
// dependências injetadas (testável sem banco). Regras:
//  * o gerador só grava RASCUNHOS; aprovação é sempre um ato do revisor sobre
//    ids que ele escolheu (individual ou lote selecionado), nunca automática;
//  * aprovar re-valida o conteúdo ATUAL (validador + definição igual à revisada);
//  * R6: TODA aprovação leva o hash do que o revisor viu (painel principal: o que
//    está na tela; manifesto: o que foi revisado fora) e o banco recalcula o hash
//    na mesma transação do UPDATE (daily_choice_admin_review_hashed). Não existe
//    mais aprovação sem hash; a função antiga só reprova ou volta a rascunho;
//  * manifesto (lote revisado fora do painel): importação e aprovação conferem o
//    HASH de cada conjunto no servidor — nada diferente do revisado entra;
//  * alternativas nunca têm quebra de linha nem caractere de controle (R2);
//  * editar um conjunto APROVADO só com pedido explícito (allowApproved): sem
//    ele, o servidor recusa em vez de rebaixar a rascunho em silêncio (R3);
//  * aprovar por manifesto não reaprova o que foi REPROVADO antes (R4), nem
//    por tabela: editar um REPROVADO (que o devolveria a rascunho e o deixaria
//    aprovável) também exige pedido explícito (allowRejected).
import { z } from "zod";
import {
  draftDistractors,
  prepareAcervo,
  validateChoiceSet,
  type AcervoWord,
  type Validation,
} from "./daily-choice-content";
import {
  ALT_PROIBIDO,
  HASH_RE,
  altText,
  setHash,
} from "./daily-choice-manifest";

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
            distractors: z.array(altText).length(3),
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
    // R6: de onde vem o hash (muda só as mensagens; a regra é a mesma)
    source: z.enum(["painel", "manifesto"]).optional(),
  })
  .strict();

/** R6: aprovação sem hash do conteúdo visto é recusada inteira. */
export const SEM_HASH =
  "Aprovar exige o hash do conteúdo exibido. Recarregue o painel e tente de novo.";
export const idsInput = z
  .object({ wordIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH) })
  .strict();
export const editInput = z
  .object({
    wordId: z.string().uuid(),
    distractors: z.array(altText).length(3),
    // R3: só o editor do painel principal, de propósito, edita um APROVADO (volta a rascunho)
    allowApproved: z.literal(true).optional(),
    // R4: idem para um REPROVADO (editar o devolve a rascunho, e daí ao lote de aprovação)
    allowRejected: z.literal(true).optional(),
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

/**
 * Aprovar/reprovar/voltar a rascunho SÓ os ids escolhidos pelo revisor.
 * R1/R6: aprovar vai SEMPRE para `reviewHashed`, que confere o hash DE NOVO
 * dentro do banco, na mesma transação do UPDATE (só aprova RASCUNHO cujo
 * conteúdo atual tem exatamente aquele hash). Sem `expected` ou sem
 * `reviewHashed`, falha: nunca cai numa aprovação sem hash.
 */
export async function reviewSets(
  deps: {
    get: (ids: string[]) => Promise<AdminItem[]>;
    review: (
      ids: string[],
      status: "reprovado" | "rascunho",
    ) => Promise<{ updated: number; skipped: number }>;
    reviewHashed?: (
      expected: Record<string, string>,
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
  const expected = input.expected;
  if (!expected) throw new Error(SEM_HASH);
  const painel = input.source === "painel";
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
    // R4/R6: aprovar não desfaz uma reprovação de uma vez; no painel, primeiro volta a rascunho
    if (it.status === "reprovado")
      reasons.push(
        painel
          ? "reprovado: volte a rascunho antes de aprovar"
          : "reprovado antes: reavalie no painel principal",
      );
    if (it.status === "aprovado") reasons.push("já aprovado");
    // R2: conjunto antigo com quebra de linha não entra por hash (a junção seria ambígua)
    if (it.distractors?.some((d) => ALT_PROIBIDO.test(d)))
      reasons.push("alternativa gravada com quebra de linha: edite antes");
    // o banco confere o hash SEM aparar: alternativa antiga com espaço nas pontas não entra
    if (it.distractors?.some((d) => d !== d.trim()))
      reasons.push("alternativa gravada com espaço nas pontas: edite antes");
    const exp = expected[it.word_id];
    if (!exp)
      reasons.push(
        painel ? "sem o hash do que foi exibido" : "fora do manifesto",
      );
    else if (
      !it.distractors ||
      (await setHash(it.word_id, it.truth, it.distractors)) !== exp
    )
      reasons.push(
        painel
          ? "mudou depois de exibido (hash): recarregue e confira de novo"
          : "conteúdo diferente do revisado (hash)",
      );
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
  if (ok.length && !deps.reviewHashed)
    throw new Error("Aprovação indisponível (sem hash no banco).");
  const r = ok.length
    ? await deps.reviewHashed!(
        Object.fromEntries(ok.map((id) => [id, expected[id]!])),
      )
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

/**
 * Edita os 3 distratores (volta a rascunho); grava o resultado do validador.
 * R3: um conjunto APROVADO só é editado com allowApproved; sem ele, nada muda.
 * R4: um REPROVADO só com allowRejected (editar o devolveria a rascunho e o
 * deixaria pronto para o "Aprovar idênticos" do manifesto).
 * As duas recusas são decididas de novo no banco, com a linha travada (alguém
 * pode ter aprovado ou reprovado entre a leitura daqui e a gravação).
 */
export async function editSet(
  deps: {
    get: (ids: string[]) => Promise<AdminItem[]>;
    edit: (
      wordId: string,
      distractors: string[],
      validacao: Validation,
      allow: { approved: boolean; rejected: boolean },
    ) => Promise<{ updated: number; blocked?: "aprovado" | "reprovado" }>;
  },
  input: z.infer<typeof editInput>,
): Promise<{
  updated: number;
  validacao: Validation | null;
  blocked?: "aprovado" | "reprovado";
}> {
  const [it] = await deps.get([input.wordId]);
  if (!it || !it.status) throw new Error("Conjunto não encontrado.");
  if (it.status === "aprovado" && !input.allowApproved)
    return { updated: 0, validacao: null, blocked: "aprovado" };
  if (it.status === "reprovado" && !input.allowRejected)
    return { updated: 0, validacao: null, blocked: "reprovado" };
  const distractors = input.distractors.map((d) => d.trim());
  const validacao = validateChoiceSet({
    word: it.word,
    truth: it.truth,
    distractors,
  });
  const r = await deps.edit(input.wordId, distractors, validacao, {
    approved: input.allowApproved === true,
    rejected: input.allowRejected === true,
  });
  return r.blocked
    ? { updated: 0, validacao: null, blocked: r.blocked }
    : { updated: r.updated, validacao };
}
