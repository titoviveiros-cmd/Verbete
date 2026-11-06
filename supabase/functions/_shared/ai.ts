// Chamada ao Gemini (endpoint OpenAI-compatível) e eventos de operação das
// edge functions. Sem APIs do Deno: coberto pelos testes Vitest em
// src/lib/__tests__/edge-ai.test.ts. O provedor pode ser trocado por
// configuração (ai-provider.ts, docs/provedor-ia.md); sem nada configurado,
// tudo aqui segue idêntico ao Gemini de sempre.

export const GEMINI_CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
export const GEMINI_MODEL = "gemini-flash-lite-latest";

export type ChatFailure = "timeout" | "network" | "http_error" | "invalid_response";

export type AttemptResult =
  | { ok: true; content: string }
  | { ok: false; reason: ChatFailure; status?: number };

export type ChatResult = AttemptResult & { attempts: number };

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Destino da chamada (perfil do provedor, montado por ai-provider.ts). Tudo
 * omitido = Gemini de sempre: mesma URL, mesmo modelo, mesmo corpo.
 */
export type ChatTarget = {
  /** Endpoint alternativo (outro provedor ou simulador nos testes). */
  url?: string;
  model?: string;
  /** Parâmetros do perfil (ex.: max_tokens); nunca sobrescrevem model/messages. */
  extraBody?: Readonly<Record<string, unknown>>;
  /** Rejeita (sem nova tentativa) marcadores de canal e finish_reason=length. */
  strictOutput?: boolean;
};

/** Só os campos de destino informados (repasse sem `undefined` explícito). */
export function pickTarget(o: ChatTarget): ChatTarget {
  return {
    ...(o.url ? { url: o.url } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.extraBody ? { extraBody: o.extraBody } : {}),
    ...(o.strictOutput ? { strictOutput: true } : {}),
  };
}

/** Marcadores de canal vazados (achado da N1b com gpt-oss: "<|channel|>"). */
const CHANNEL_MARKER = /<\|(?:start|end|channel|message|return|call|constrain)\|>/i;

/** Falhas transitórias que valem uma nova tentativa. 429 (cota/ritmo) vale
 *  UMA só: o limite do Gemini é por minuto e insistir em segundos só gasta
 *  chamadas — quem espera o minuto é o reenvio do banco (22/10: as rodadas
 *  com 429 voltaram 1 min depois). */
function retriable(r: AttemptResult, attemptIndex: number): boolean {
  if (r.ok) return false;
  if (r.reason === "timeout" || r.reason === "network") return true;
  if (r.reason !== "http_error") return false;
  if (r.status === 429) return attemptIndex === 0;
  return (r.status ?? 0) >= 500;
}

async function attempt(
  fetchFn: FetchFn,
  url: string,
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number,
  temperature: number | undefined,
  target: ChatTarget,
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
      body: JSON.stringify({
        ...(target.extraBody ?? {}),
        model: target.model || GEMINI_MODEL,
        messages,
        ...(temperature === undefined ? {} : { temperature }),
      }),
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
    const choice = (
      data as {
        choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
      }
    )?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return { ok: false, reason: "invalid_response" };
    }
    // Perfis estritos: resposta cortada ou com canal interno vazado é falha
    // do provedor, não conteúdo — invalid_response não ganha nova tentativa.
    if (
      target.strictOutput &&
      (choice?.finish_reason === "length" || CHANNEL_MARKER.test(content))
    ) {
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
export async function callChat(opts: ChatTarget & {
  fetchFn: FetchFn;
  apiKey: string;
  messages: Array<{ role: string; content: string }>;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  /** Prazo TOTAL, somando tentativas e esperas: cada tentativa usa no
   *  máximo o que resta, e nenhuma nova começa com menos de `minAttemptMs`.
   *  Omitido = sem prazo total (bots e Diário seguem como antes). */
  deadlineMs?: number;
  minAttemptMs?: number;
  /** Chamado ao fim de cada tentativa (trilha da auditoria). */
  onAttempt?: (r: AttemptResult) => void;
  /** Omitida = padrão do modelo (geração criativa dos bots). */
  temperature?: number;
}): Promise<ChatResult> {
  const url = opts.url || GEMINI_CHAT_URL;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const retries = opts.retries ?? 1;
  const backoffMs = opts.backoffMs ?? 700;
  const minAttemptMs = opts.minAttemptMs ?? 1500;
  const t0 = Date.now();
  const left = () =>
    opts.deadlineMs === undefined ? Infinity : opts.deadlineMs - (Date.now() - t0);
  let last: ChatResult = { ok: false, reason: "network", attempts: 0 };
  for (let i = 0; i <= retries; i++) {
    if (i > 0) {
      // sem tempo para a espera e uma tentativa útil: fica a última falha
      if (left() - backoffMs * i < minAttemptMs) return last;
      await new Promise((res) => setTimeout(res, backoffMs * i));
    }
    const res = await attempt(
      opts.fetchFn,
      url,
      opts.apiKey,
      opts.messages,
      Math.min(timeoutMs, left()),
      opts.temperature,
      opts,
    );
    opts.onAttempt?.(res);
    last = { ...res, attempts: i + 1 };
    if (!retriable(res, i)) return last;
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
  | "judge_ai_error"
  | "ai_guard"; // V3: guarda das edges (room-guard.ts) e julgamento repetido

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
