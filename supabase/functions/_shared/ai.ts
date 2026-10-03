// Chamada ao Gemini (endpoint OpenAI-compatível) e eventos de operação das
// edge functions. Sem APIs do Deno: coberto pelos testes Vitest em
// src/lib/__tests__/edge-ai.test.ts.

export const GEMINI_CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
export const GEMINI_MODEL = "gemini-flash-lite-latest";

export type ChatFailure = "timeout" | "network" | "http_error" | "invalid_response";

type AttemptResult =
  | { ok: true; content: string }
  | { ok: false; reason: ChatFailure; status?: number };

export type ChatResult = AttemptResult & { attempts: number };

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** Falhas transitórias que valem uma nova tentativa. */
function retriable(r: AttemptResult): boolean {
  if (r.ok) return false;
  if (r.reason === "timeout" || r.reason === "network") return true;
  return r.reason === "http_error" && (r.status === 429 || (r.status ?? 0) >= 500);
}

async function attempt(
  fetchFn: FetchFn,
  url: string,
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number,
): Promise<AttemptResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: GEMINI_MODEL, messages }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      await r.text().catch(() => "");
      return { ok: false, reason: "http_error", status: r.status };
    }
    let data: unknown;
    try {
      data = await r.json();
    } catch {
      return { ok: false, reason: "invalid_response" };
    }
    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })
      ?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return { ok: false, reason: "invalid_response" };
    }
    return { ok: true, content };
  } catch {
    return { ok: false, reason: ctrl.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chama o modelo com timeout por tentativa e até `retries` novas tentativas
 * em falha transitória (timeout, rede, 429, 5xx). Nunca lança.
 */
export async function callChat(opts: {
  fetchFn: FetchFn;
  apiKey: string;
  messages: Array<{ role: string; content: string }>;
  /** Endpoint alternativo (testes de ponta a ponta com Gemini simulado). */
  url?: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}): Promise<ChatResult> {
  const url = opts.url || GEMINI_CHAT_URL;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const retries = opts.retries ?? 1;
  const backoffMs = opts.backoffMs ?? 700;
  let last: ChatResult = { ok: false, reason: "network", attempts: 0 };
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise((res) => setTimeout(res, backoffMs * i));
    const res = await attempt(opts.fetchFn, url, opts.apiKey, opts.messages, timeoutMs);
    last = { ...res, attempts: i + 1 };
    if (!retriable(res)) return last;
  }
  return last;
}

/** Extrai o primeiro objeto JSON da resposta do modelo (tolera markdown/ruído). */
export function parseJsonObject(content: string): Record<string, unknown> | null {
  const match = content.match(/\{[\s\S]*\}/);
  try {
    const parsed: unknown = JSON.parse(match ? match[0] : content);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type OpsEventKind =
  | "bot_ai_success"
  | "bot_ai_fallback"
  | "bot_ai_error"
  | "judge_ai_success"
  | "judge_ai_error";

export type OpsEvent = { kind: OpsEventKind; payload: Record<string, string | number | boolean> };

/**
 * Evento de exceção inesperada (ex.: o ReferenceError que derrubou a geração
 * de 27/07 a 02/10). Só nome e mensagem curta do erro — nunca prompt,
 * palavra, verdade ou texto de jogador.
 */
export function exceptionEvent(
  kind: "bot_ai_error" | "judge_ai_error",
  fn: string,
  err: unknown,
  latencyMs: number,
): OpsEvent {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    kind,
    payload: {
      fn,
      reason: "exception",
      error_name: e.name.slice(0, 40),
      error_message: e.message.slice(0, 120),
      latency_ms: latencyMs,
    },
  };
}
