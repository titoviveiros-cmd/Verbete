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
import { scoreGuess } from "../../supabase/functions/_shared/semantic.ts";

export const DAILY_EVAL_UNAVAILABLE =
  "A avaliação está indisponível agora — sua tentativa NÃO foi gasta. Tente de novo em instantes.";

const submitInput = z.object({
  guess: z.string().min(1).max(200),
  timeSeconds: z.number().int().min(0).max(600),
});

function hourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// null = avaliação indisponível (sem chave, Gemini fora após nova tentativa,
// resposta inválida). Antes virava 0: o palpite era gravado como ERRADO e a
// tentativa do dia era consumida sem o jogador saber (IA-04).
async function scoreSemanticSimilarity(
  word: string,
  truth: string,
  guess: string,
): Promise<number | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const res = await scoreGuess({ fetchFn: fetch, apiKey, word, truth, guess });
  return res.ok ? res.score : null;
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

    // 2) Calcula a semelhança semântica via IA. Indisponível = NÃO registra
    // (a tentativa não é gasta) e o painel de saúde/alerta fica sabendo.
    const similarity = truth
      ? await scoreSemanticSimilarity(word, truth, data.guess)
      : 0;
    if (similarity === null) {
      await supabaseAdmin
        .from("ops_events")
        .insert({
          kind: "judge_ai_error",
          payload: { fn: "daily", reason: "unavailable" },
        })
        .then(
          () => {},
          () => {},
        );
      throw new Error(DAILY_EVAL_UNAVAILABLE);
    }

    // 3) Registra via RPC de servidor (apenas service_role pode chamar).
    const { data: result, error } = await supabaseAdmin.rpc(
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
