// Avaliação do Desafio Diário, separada do server function para ser testada
// sem rede nem banco. Incidente de 03/11/2026 (22:06 e 22:07): o Gemini
// falhou duas vezes, o evento só dizia "unavailable" e o Worker não guarda
// logs — não deu para saber se foi 429, 5xx, timeout ou resposta inválida.
// Agora o evento traz o motivo, o status HTTP, as tentativas e a duração.
// NUNCA entram no evento: palavra, definição, palpite, jogador ou chave.
import {
  pickTarget,
  type ChatFailure,
  type ChatTarget,
} from "../../supabase/functions/_shared/ai.ts";
import { scoreGuess } from "../../supabase/functions/_shared/semantic.ts";

export const DAILY_EVAL_UNAVAILABLE =
  "A avaliação está indisponível agora — sua tentativa NÃO foi gasta. Tente de novo em instantes.";

export type DailyEvalFailureReason =
  ChatFailure | "missing_key" | "missing_truth";

export type DailyEvalResult =
  | { ok: true; similarity: number; attempts: number; latencyMs: number }
  | {
      ok: false;
      reason: DailyEvalFailureReason;
      status?: number;
      attempts: number;
      latencyMs: number;
    };

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Nota 0–100 do palpite. Sem chave ou sem definição sorteada não chama a IA:
 * é falha (o jogador tenta de novo), nunca nota 0 — antes, verdade vazia
 * virava 0 e a tentativa do dia era gasta como ERRADA.
 */
export async function evaluateDailyGuess(
  opts: ChatTarget & {
    fetchFn: Fetch;
    apiKey: string | undefined;
    word: string;
    truth: string;
    guess: string;
    now?: () => number;
  },
): Promise<DailyEvalResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  if (!opts.apiKey)
    return { ok: false, reason: "missing_key", attempts: 0, latencyMs: 0 };
  if (!opts.truth.trim())
    return { ok: false, reason: "missing_truth", attempts: 0, latencyMs: 0 };
  const res = await scoreGuess({
    fetchFn: opts.fetchFn,
    apiKey: opts.apiKey,
    ...pickTarget(opts),
    word: opts.word,
    truth: opts.truth,
    guess: opts.guess,
  });
  const latencyMs = Math.max(0, now() - t0);
  if (res.ok)
    return {
      ok: true,
      similarity: res.score,
      attempts: res.attempts,
      latencyMs,
    };
  return {
    ok: false,
    reason: res.reason,
    ...(res.status !== undefined ? { status: res.status } : {}),
    attempts: res.attempts,
    latencyMs,
  };
}

export type DailyFailureEvent = {
  kind: "judge_ai_error";
  build: string | null;
  payload: Record<string, string | number>;
};

/** Evento operacional da falha: só metadados técnicos, lista fechada de campos. */
export function dailyFailureEvent(
  r: Extract<DailyEvalResult, { ok: false }>,
  build: string | null | undefined,
): DailyFailureEvent {
  return {
    kind: "judge_ai_error",
    build: build || null,
    payload: {
      fn: "daily",
      reason: r.reason,
      ...(r.status !== undefined ? { status: r.status } : {}),
      attempts: r.attempts,
      latency_ms: r.latencyMs,
    },
  };
}

/**
 * Avalia e só então grava. Falha = evento + erro ao jogador, SEM chamar
 * `record` (a tentativa não é gasta). Falha ao gravar o evento não muda nada.
 */
export async function runDailyEvaluation<T>(opts: {
  evaluate: () => Promise<DailyEvalResult>;
  record: (similarity: number) => Promise<T>;
  logEvent: (ev: DailyFailureEvent) => Promise<unknown>;
  build: string | null | undefined;
}): Promise<T> {
  const r = await opts.evaluate();
  if (!r.ok) {
    const ev = dailyFailureEvent(r, opts.build);
    console.warn("[daily] avaliação indisponível", JSON.stringify(ev.payload));
    try {
      await opts.logEvent(ev);
    } catch {
      /* telemetria nunca derruba a resposta ao jogador */
    }
    throw new Error(DAILY_EVAL_UNAVAILABLE);
  }
  return opts.record(r.similarity);
}
