// Avaliação do Desafio Diário, separada do server function para ser testada
// sem rede nem banco. Incidente de 03/11/2026 (22:06 e 22:07): o Gemini
// falhou duas vezes, o evento só dizia "unavailable" e o Worker não guarda
// logs — não deu para saber se foi 429, 5xx, timeout ou resposta inválida.
// Agora o evento traz o motivo, o status HTTP, as tentativas e a duração.
// Incidente de 04/11 (timeout, 2 × 8 s): o evento passa a trazer também o
// modelo e o resultado/duração de CADA tentativa, e o sucesso também vira
// evento (latência do Diário fica visível antes de virar falha).
// NUNCA entram no evento: palavra, definição, palpite, jogador ou chave.
import type {
  AttemptResult,
  ChatFailure,
} from "../../supabase/functions/_shared/ai.ts";
import { scoreGuess } from "../../supabase/functions/_shared/semantic.ts";

export const DAILY_EVAL_UNAVAILABLE =
  "A avaliação está indisponível agora — sua tentativa NÃO foi gasta. Tente de novo em instantes.";

export type DailyEvalFailureReason =
  ChatFailure | "missing_key" | "missing_truth";

/** Uma tentativa: o modelo, "ok"/o motivo/o status HTTP e a duração em ms. */
export type DailyTry = { model: string; result: string; ms: number };

export type DailyEvalResult =
  | {
      ok: true;
      similarity: number;
      attempts: number;
      latencyMs: number;
      tries?: DailyTry[];
    }
  | {
      ok: false;
      reason: DailyEvalFailureReason;
      status?: number;
      attempts: number;
      latencyMs: number;
      tries?: DailyTry[];
    };

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

function tryResult(r: AttemptResult): string {
  if (r.ok) return "ok";
  return r.status !== undefined ? String(r.status) : r.reason;
}

/**
 * Nota 0–100 do palpite. Sem chave ou sem definição sorteada não chama a IA:
 * é falha (o jogador tenta de novo), nunca nota 0 — antes, verdade vazia
 * virava 0 e a tentativa do dia era gasta como ERRADA.
 */
export async function evaluateDailyGuess(opts: {
  fetchFn: Fetch;
  apiKey: string | undefined;
  word: string;
  truth: string;
  guess: string;
  url?: string;
  now?: () => number;
}): Promise<DailyEvalResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  if (!opts.apiKey)
    return { ok: false, reason: "missing_key", attempts: 0, latencyMs: 0 };
  if (!opts.truth.trim())
    return { ok: false, reason: "missing_truth", attempts: 0, latencyMs: 0 };
  const tries: DailyTry[] = [];
  const res = await scoreGuess({
    fetchFn: opts.fetchFn,
    apiKey: opts.apiKey,
    url: opts.url,
    word: opts.word,
    truth: opts.truth,
    guess: opts.guess,
    onAttempt: (r, ms, model) =>
      tries.push({ model, result: tryResult(r), ms }),
  });
  const latencyMs = Math.max(0, now() - t0);
  if (res.ok)
    return {
      ok: true,
      similarity: res.score,
      attempts: res.attempts,
      latencyMs,
      tries,
    };
  return {
    ok: false,
    reason: res.reason,
    ...(res.status !== undefined ? { status: res.status } : {}),
    attempts: res.attempts,
    latencyMs,
    tries,
  };
}

export type DailyOpsEvent = {
  kind: "judge_ai_error" | "judge_ai_success";
  build: string | null;
  payload: Record<string, string | number>;
};
/** Mantido pelo nome antigo (testes e chamadas existentes). */
export type DailyFailureEvent = DailyOpsEvent;

/** Nome curto e só técnico do modelo ("gemini-3.5-flash" → "3.5-flash"). */
const shortModel = (m: string) => m.replace(/^gemini-/, "").slice(0, 40);

/** "flash-lite-latest:timeout:6000,3.5-flash:ok:2100": no máximo 3 entradas. */
function triesText(tries: DailyTry[] | undefined): string | undefined {
  if (!tries || tries.length === 0) return undefined;
  return tries
    .slice(0, 3)
    .map(
      (t) =>
        `${shortModel(t.model)}:${t.result}:${Math.max(0, Math.round(t.ms))}`,
    )
    .join(",");
}

/** Evento operacional: só metadados técnicos, lista fechada de campos. */
export function dailyEvent(
  r: DailyEvalResult,
  build: string | null | undefined,
): DailyOpsEvent {
  const tries = triesText(r.tries);
  // modelo da ÚLTIMA tentativa: no sucesso, o que deu a nota
  const last = r.tries?.at(-1)?.model;
  return {
    kind: r.ok ? "judge_ai_success" : "judge_ai_error",
    build: build || null,
    payload: {
      fn: "daily",
      ...(r.ok ? {} : { reason: r.reason }),
      ...(!r.ok && r.status !== undefined ? { status: r.status } : {}),
      attempts: r.attempts,
      latency_ms: r.latencyMs,
      ...(last ? { model: last } : {}),
      ...(tries ? { tries } : {}),
    },
  };
}

/** Evento da falha (nome antigo, mesmo formato de dailyEvent). */
export function dailyFailureEvent(
  r: Extract<DailyEvalResult, { ok: false }>,
  build: string | null | undefined,
): DailyOpsEvent {
  return dailyEvent(r, build);
}

/** Telemetria nunca derruba a resposta ao jogador; falha de gravação vira
 *  aviso no log do Worker (só o código do erro, sem dados). */
async function safeLog(
  logEvent: (ev: DailyOpsEvent) => Promise<unknown>,
  ev: DailyOpsEvent,
): Promise<void> {
  try {
    await logEvent(ev);
  } catch (e) {
    const code =
      (e as { code?: unknown } | null)?.code ??
      (e instanceof Error ? e.name : "erro");
    console.warn("[daily] falha ao gravar ops_events", String(code));
  }
}

/**
 * Avalia e só então grava. Falha = evento + erro ao jogador, SEM chamar
 * `record` (a tentativa não é gasta). Sucesso = grava a tentativa com a nota
 * e registra o evento de sucesso (latência por tentativa). Falha ao gravar o
 * evento não muda nada para o jogador.
 */
export async function runDailyEvaluation<T>(opts: {
  evaluate: () => Promise<DailyEvalResult>;
  record: (similarity: number) => Promise<T>;
  logEvent: (ev: DailyOpsEvent) => Promise<unknown>;
  build: string | null | undefined;
}): Promise<T> {
  const r = await opts.evaluate();
  const ev = dailyEvent(r, opts.build);
  if (!r.ok) {
    console.warn("[daily] avaliação indisponível", JSON.stringify(ev.payload));
    await safeLog(opts.logEvent, ev);
    throw new Error(DAILY_EVAL_UNAVAILABLE);
  }
  const logged = safeLog(opts.logEvent, ev);
  try {
    return await opts.record(r.similarity);
  } finally {
    await logged;
  }
}
