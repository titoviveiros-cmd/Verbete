// Server functions para o Daily Word Challenge.
// O scoring usa similaridade SEMÂNTICA (IA) — não letra a letra — com a MESMA
// rubrica do juiz do multiplayer (supabase/functions/_shared/semantic.ts): o
// Diário guarda a nota 0–100 e o SQL considera correto >= 80. A verdade é
// buscada no servidor (service role) e nunca volta ao cliente até a
// tentativa ser registrada.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { evaluateDailyGuess, runDailyEvaluation } from "./daily-evaluation";

export { DAILY_EVAL_UNAVAILABLE } from "./daily-evaluation";

const submitInput = z.object({
  guess: z.string().min(1).max(200),
  timeSeconds: z.number().int().min(0).max(600),
});

function hourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export const submitDailyAttempt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => submitInput.parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;

    // 1) Resolve a palavra/verdade do bucket atual via service role.
    await supabaseAdmin.rpc("get_or_create_daily_challenge");
    const hourIso = hourBucketIso();
    const { data: challenge } = await supabaseAdmin
      .from("daily_challenges")
      .select("word_id")
      .eq("challenge_hour", hourIso)
      .maybeSingle();
    let word = "";
    let truth = "";
    if (challenge?.word_id) {
      const { data: w } = await supabaseAdmin
        .from("words")
        .select("word, meaning")
        .eq("id", challenge.word_id)
        .maybeSingle();
      word = String(w?.word ?? "");
      truth = String(w?.meaning ?? "");
    }

    // 2) Calcula a semelhança semântica via IA. Indisponível (sem chave, sem
    // definição, Gemini fora após as novas tentativas, resposta inválida) =
    // NÃO registra (a tentativa não é gasta, nunca vira nota 0) e o evento
    // diz o motivo para o painel de saúde/alerta.
    // 3) Registra via RPC de servidor (apenas service_role pode chamar).
    const result = await runDailyEvaluation({
      evaluate: () =>
        evaluateDailyGuess({
          fetchFn: fetch,
          apiKey: process.env.GEMINI_API_KEY,
          word,
          truth,
          guess: data.guess,
        }),
      logEvent: async (ev) => {
        await supabaseAdmin.from("ops_events").insert(ev);
      },
      build: import.meta.env.VITE_BUILD_ID as string | undefined,
      record: async (similarity) => {
        const { data: recorded, error } = await supabaseAdmin.rpc(
          "submit_daily_attempt_scored",
          {
            p_user_id: userId,
            p_guess: data.guess,
            p_time_seconds: data.timeSeconds,
            p_similarity: similarity,
          },
        );
        if (error) {
          console.error("[submitDailyAttempt] rpc error", error);
          throw new Error(
            `Não foi possível registrar sua tentativa. [${(error as { code?: string }).code ?? "?"}: ${(error as { message?: string }).message ?? "?"}]`,
          );
        }
        return recorded;
      },
    });
    return result as {
      already_played: boolean;
      is_correct?: boolean;
      score?: number;
      similarity?: number;
      truth?: string;
      word?: string;
      current_streak?: number;
      unlocked?: string[];
      attempt?: { guess: string; is_correct: boolean; score: number };
    };
  });
