// Server functions do Desafio Diário D1 (modo escolha) e da revisão editorial.
// Arquivo NOVO: as server functions existentes (e os IDs que o APK 2.1.4
// instalado chama) não mudam. Nada aqui chama IA.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  runChoiceFinish,
  runChoiceStart,
  type ChoiceEvent,
} from "./daily-choice";
import { choiceInput } from "./daily-input";
import {
  ADMIN_ONLY,
  editInput,
  editSet,
  draftsInput,
  idsInput,
  poolInput,
  saveDrafts,
  listInput,
  reviewInput,
  reviewSets,
  type AdminItem,
} from "./daily-choice-admin";

type AcervoRow = {
  id: string;
  word: string;
  meaning: string;
  classe: string | null;
  category: string | null;
};

const build = () => import.meta.env.VITE_BUILD_ID as string | undefined;
const logEvent = async (ev: ChoiceEvent) => {
  await supabaseAdmin.from("ops_events").insert(ev);
};
const rpcOrThrow = async (fn: string, args: Record<string, unknown>) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin.rpc as any)(fn, args);
  if (error)
    throw new Error(`${fn} ${(error as { code?: string }).code ?? "?"}`);
  return data as unknown;
};

/** Abre (ou reabre) as alternativas da hora. O relógio do servidor começa aqui. */
export const startDailyChoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    runChoiceStart({
      start: () =>
        rpcOrThrow("daily_choice_start", { p_user_id: context.userId }),
      logEvent,
      build: build(),
    }),
  );

/** Responde com a POSIÇÃO escolhida. Tempo e acerto: só o servidor decide. */
export const submitDailyChoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => choiceInput.parse(input))
  .handler(async ({ data, context }) =>
    runChoiceFinish({
      finish: () =>
        rpcOrThrow("daily_choice_finish", {
          p_user_id: context.userId,
          p_pos: data.pos,
          p_hour: data.hour,
        }),
      logEvent,
      build: build(),
    }),
  );

// ---------------------------------------------------------------------------
// Revisão editorial (papel admin conferido no servidor a cada chamada)
// ---------------------------------------------------------------------------
async function assertAdmin(context: {
  supabase: typeof supabaseAdmin;
  userId: string;
}) {
  const { data } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error(ADMIN_ONLY);
}
const getItems = async (ids: string[]) =>
  ((await rpcOrThrow("daily_choice_admin_get", { p_word_ids: ids })) ??
    []) as AdminItem[];

export const listDailyChoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => listInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    return (await rpcOrThrow("daily_choice_admin_list", {
      p_status: data.status,
      p_limit: 50,
      p_offset: data.offset,
    })) as {
      counts: Record<string, number>;
      total: number;
      items: Array<
        AdminItem & {
          category: string | null;
          classe: string | null;
          validacao: {
            ok?: boolean;
            issues?: Array<{ index: number; msg: string }>;
          };
          reviewed_at: string | null;
        }
      >;
    };
  });

/** Conjuntos de uma lista de palavras (manifesto de um lote revisado). Só leitura. */
export const getDailyChoicesByIds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => idsInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    return getItems(Array.from(new Set(data.wordIds)));
  });

/** Acervo para o navegador do revisor gerar os rascunhos (sem CPU no Worker). */
export const getDailyChoicePool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => poolInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    return (await rpcOrThrow("daily_choice_admin_pool", {
      p_limit: data.limit,
    })) as { targets: AcervoRow[]; pool: AcervoRow[] };
  });

/** Grava RASCUNHOS gerados no navegador — re-validados aqui contra a definição atual. */
export const addDailyChoiceDrafts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => draftsInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    return saveDrafts(
      {
        get: getItems,
        addDrafts: async (rows) =>
          Number(
            await rpcOrThrow("daily_choice_admin_add_drafts", { p_rows: rows }),
          ),
      },
      data,
    );
  });

export const reviewDailyChoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => reviewInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    return reviewSets(
      {
        get: getItems,
        // R6: a função antiga só REPROVA ou volta a RASCUNHO; aprovar nunca passa por aqui
        review: async (ids, status) => {
          if (status !== "reprovado" && status !== "rascunho")
            throw new Error(
              "daily_choice_admin_review: só reprovar ou rascunho",
            );
          return (await rpcOrThrow("daily_choice_admin_review", {
            p_word_ids: ids,
            p_status: status,
            p_reviewer: context.userId,
          })) as { updated: number; skipped: number };
        },
        // R1/R6: toda aprovação → o banco recalcula o hash na mesma transação do UPDATE
        reviewHashed: async (expected) =>
          (await rpcOrThrow("daily_choice_admin_review_hashed", {
            p_expected: expected,
            p_reviewer: context.userId,
          })) as { updated: number; skipped: number },
      },
      data,
    );
  });

export const editDailyChoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => editInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    return editSet(
      {
        get: getItems,
        // R3/R4: a trava de APROVADO/REPROVADO é decidida no banco, com a linha travada
        edit: async (wordId, distractors, validacao, allow) => {
          const r = (await rpcOrThrow("daily_choice_admin_edit_guarded", {
            p_word_id: wordId,
            p_distractors: distractors,
            p_validacao: validacao,
            p_allow_approved: allow.approved,
            p_allow_rejected: allow.rejected,
          })) as { updated?: number; blocked?: string } | null;
          return r?.blocked === "aprovado" || r?.blocked === "reprovado"
            ? { updated: 0, blocked: r.blocked }
            : { updated: Number(r?.updated ?? 0) };
        },
      },
      data,
    );
  });
