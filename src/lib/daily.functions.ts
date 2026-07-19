// Server functions para o Daily Word Challenge.
// O scoring usa similaridade SEMÂNTICA (IA) — não letra a letra — para que
// palpites como "extravagante, excêntrico" contem como acerto vs "extravagante,
// esquisito". A verdade é buscada no servidor (service role) e nunca volta ao
// cliente até a tentativa ser registrada.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const submitInput = z.object({
  guess: z.string().min(1).max(200),
  timeSeconds: z.number().int().min(0).max(600),
});

function hourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

async function scoreSemanticSimilarity(word: string, truth: string, guess: string): Promise<number> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return 0;
  const system =
    'Você avalia equivalência semântica entre duas definições curtas (PT-BR) de uma palavra. Retorne APENAS JSON {"score": <inteiro 0-100>} representando o quanto a definição do jogador transmite o mesmo significado essencial da verdadeira. 100 = idêntico em significado (sinônimos / paráfrases contam). 80+ = essencialmente correto. 0 = sem relação. Ignore estilo, acentos, ordem, pontuação.';
  const user = `Palavra: ${word}\nDefinição verdadeira: "${truth}"\nDefinição do jogador: "${guess}"\n\nResponda só o JSON.`;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-flash-latest",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) return 0;
    const data = await r.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    const m = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : content);
    const n = Math.round(Number(parsed?.score));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  } catch {
    return 0;
  }
}

export const submitDailyAttempt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => submitInput.parse(input))
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

    // 2) Calcula a semelhança semântica via IA (fallback 0 se falhar).
    const similarity = truth ? await scoreSemanticSimilarity(word, truth, data.guess) : 0;

    // 3) Registra via RPC de servidor (apenas service_role pode chamar).
    const { data: result, error } = await supabaseAdmin.rpc("submit_daily_attempt_scored", {
      p_user_id: userId,
      p_guess: data.guess,
      p_time_seconds: data.timeSeconds,
      p_similarity: similarity,
    });
    if (error) {
      console.error("[submitDailyAttempt] rpc error", error);
      throw new Error("Não foi possível registrar sua tentativa. Tente novamente.");
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


