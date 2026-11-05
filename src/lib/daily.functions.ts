// Server functions para o Daily Word Challenge.
// O scoring usa similaridade SEMÂNTICA (IA) — não letra a letra — com a MESMA
// rubrica do juiz do multiplayer (supabase/functions/_shared/semantic.ts): o
// Diário guarda a nota 0–100 e o SQL considera correto >= 80. A verdade é
// buscada no servidor (service role) e nunca volta ao cliente até a
// tentativa ser registrada.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { evaluateDailyGuess } from "./daily-evaluation";
import {
  DAILY_PREP_TIMEOUT_MS,
  runGuardedDailyAttempt,
  withTimeout,
  type ClaimResponse,
  type FinishOkResponse,
} from "./daily-guard";

export { DAILY_EVAL_UNAVAILABLE } from "./daily-evaluation";

import { submitInput } from "./daily-input";

function hourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export const submitDailyAttempt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => submitInput.parse(input))
  .handler(async ({ data, context }) => {
    // userId vem SEMPRE da sessão validada pelo middleware (inclusive convidado
    // anônimo); o cliente não envia identidade (o schema de entrada nem aceita).
    const { userId } = context;
    // hora do desafio: a do BANCO (devolvida por daily_claim); a do Worker só
    // vale se o banco não devolver (fluxo antigo / modo desligado)
    let hourIso = hourBucketIso();

    // Palavra/verdade do bucket da RESERVA, via service role, só quando a IA
    // vai mesmo ser chamada (pedido recusado não lê nada nem chama a IA).
    const loadChallenge = async () => {
      await supabaseAdmin.rpc("get_or_create_daily_challenge");
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
      return { word, truth };
    };

    // V2 (05/11/2026): reserva atômica ANTES da IA (supabase/migrations/
    // 20261105150000_daily_guard_v2.sql). Banco fora = sem IA. Falha da IA
    // nunca gasta a tentativa. Modo 'desligado' = fluxo antigo, idêntico.
    const result = await runGuardedDailyAttempt({
      claim: async () => {
        const { data: claimed, error } = await supabaseAdmin.rpc(
          "daily_claim",
          {
            p_user_id: userId,
            p_hour: hourIso,
          },
        );
        if (error) throw new Error(`daily_claim ${error.code ?? "?"}`);
        const c = claimed as unknown as ClaimResponse;
        if (
          c &&
          typeof c.hour === "string" &&
          !Number.isNaN(Date.parse(c.hour))
        )
          hourIso = new Date(c.hour).toISOString();
        return c;
      },
      evaluate: async () => {
        // prazo nas leituras: sem palavra/definição a tempo = falha NOSSA, sem IA
        const { word, truth } = await withTimeout(
          loadChallenge(),
          DAILY_PREP_TIMEOUT_MS,
          {
            word: "",
            truth: "",
          },
        );
        return evaluateDailyGuess({
          fetchFn: fetch,
          apiKey: process.env.GEMINI_API_KEY,
          word,
          truth,
          guess: data.guess,
        });
      },
      finishOk: async (claimId, similarity) => {
        const { data: fin, error } = await supabaseAdmin.rpc(
          "daily_finish_ok",
          {
            p_user_id: userId,
            p_hour: hourIso,
            p_claim_id: claimId,
            p_guess: data.guess,
            p_time_seconds: data.timeSeconds,
            p_similarity: similarity,
          },
        );
        if (error) throw new Error(`daily_finish_ok ${error.code ?? "?"}`);
        return fin as unknown as FinishOkResponse;
      },
      finishFail: async (claimId, kind) => {
        await supabaseAdmin.rpc("daily_finish_fail", {
          p_user_id: userId,
          p_hour: hourIso,
          p_claim_id: claimId,
          p_kind: kind,
        });
      },
      logEvent: async (ev) => {
        await supabaseAdmin.from("ops_events").insert(ev);
      },
      build: import.meta.env.VITE_BUILD_ID as string | undefined,
      legacyRecord: async (similarity) => {
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
