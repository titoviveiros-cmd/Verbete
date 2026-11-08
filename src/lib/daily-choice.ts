// Desafio Diário D1 — modo ESCOLHA (múltipla escolha, sem IA). 08/11/2026.
// Decisões aprovadas pelo dono (APROVAÇÃO CONSOLIDADA DO DIÁRIO D1):
//   D-a  app_config.daily_mode = 'escolha' é FIXO quando ligado: não volta ao
//        juiz sozinho quando ai_mode muda. 'juiz' (padrão) = fluxo atual.
//   D-b  4 alternativas: a verdadeira + 3 distratores.
//   D-c  acerto = max(round(max(100 − t, 20) × 0,5), 10) → 10 a 50; erro = 0;
//        t = segundos medidos NO SERVIDOR (início → fim), limitado a 600.
//   D-d  os pontos entram UMA vez no total do ranking global, sem fator extra.
// Lógica pura e orquestração com dependências injetadas: testável sem rede,
// sem banco e sem IA (nada aqui chama fetch).

export const CHOICE_OPTIONS = 4;
/** Barra visual de tempo da tela (o servidor mede o tempo de verdade). */
export const CHOICE_TIME_LIMIT_S = 60;
export const CHOICE_MAX_SECONDS = 600;

/** D-c: pontos do acerto pelo tempo do servidor. Erro = 0 (fora daqui). */
export function choicePoints(serverSeconds: number): number {
  const t = Math.min(
    CHOICE_MAX_SECONDS,
    Math.max(
      0,
      Math.floor(
        Number.isFinite(serverSeconds) ? serverSeconds : CHOICE_MAX_SECONDS,
      ),
    ),
  );
  return Math.max(Math.round(Math.max(100 - t, 20) * 0.5), 10);
}

// ---------------------------------------------------------------------------
// Mensagens ao jogador (nenhuma fala em IA, juiz, nota ou semelhança)
// ---------------------------------------------------------------------------
export const CHOICE_MODE_CHANGED =
  "O Desafio Diário mudou de modo — recarregue a página. Sua tentativa NÃO foi gasta.";
/** Envio do modo juiz (site antigo ou APK 2.1.4) com o Diário em múltipla escolha. */
export const DAILY_NOW_CHOICE =
  "O Desafio Diário agora é de múltipla escolha. Recarregue a página ou atualize o app — sua tentativa NÃO foi gasta.";
export const CHOICE_NO_SESSION =
  "Não encontramos as alternativas que você abriu — recarregue a página. Sua tentativa NÃO foi gasta.";
export const CHOICE_HOUR_CHANGED =
  "O desafio virou de hora antes da sua resposta — sua tentativa NÃO foi gasta. Jogue o desafio novo.";
export const CHOICE_UNAVAILABLE =
  "Não foi possível falar com o servidor agora — sua tentativa NÃO foi gasta. Tente de novo em instantes.";
export const CHOICE_PAUSED =
  "O Desafio Diário está em pausa para manutenção — sua tentativa NÃO foi gasta. Volte mais tarde!";

// ---------------------------------------------------------------------------
// Início: o que o cliente recebe (lista FECHADA de campos)
// ---------------------------------------------------------------------------
export type ChoiceOption = { pos: number; text: string };
export type ChoiceStartView =
  | {
      status: "ok";
      word: string;
      category: string | null;
      options: ChoiceOption[];
      /** segundos já corridos desde o início (reabrir a página não zera o relógio) */
      elapsedS: number;
      /** hora (ISO) das alternativas mostradas: volta no envio (Red Team A4) */
      hour: string;
    }
  | { status: "already_played" }
  | { status: "mode"; mode: "juiz" | "pausa" };

/**
 * Converte a resposta do banco no que vai ao cliente, campo a campo. Nada de
 * índice/flag/hash da correta, id de palavra, de sessão ou de linha: mesmo que
 * o banco devolva algo a mais, só sai o que está listado aqui.
 */
export function sanitizeChoiceStart(raw: unknown): ChoiceStartView {
  const r = (raw ?? {}) as Record<string, unknown>;
  const status = String(r.status ?? "");
  if (status === "already_played") return { status: "already_played" };
  if (status === "mode") {
    return { status: "mode", mode: r.mode === "pausa" ? "pausa" : "juiz" };
  }
  if (status === "sem_estoque") throw new Error(CHOICE_PAUSED);
  if (status !== "ok") throw new Error(CHOICE_UNAVAILABLE);
  const opts = Array.isArray(r.options) ? r.options : [];
  const options: ChoiceOption[] = opts.map((o) => {
    const x = (o ?? {}) as Record<string, unknown>;
    return { pos: Number(x.pos), text: String(x.text ?? "") };
  });
  const posOk =
    options.length === CHOICE_OPTIONS &&
    options.every((o, i) => o.pos === i && o.text.trim().length > 0);
  const word = String(r.word ?? "");
  if (!posOk || !word) throw new Error(CHOICE_UNAVAILABLE);
  const elapsed = Number(r.elapsed_s);
  const hour =
    typeof r.hour === "string" && !Number.isNaN(Date.parse(r.hour))
      ? new Date(r.hour).toISOString()
      : "";
  if (!hour) throw new Error(CHOICE_UNAVAILABLE);
  return {
    status: "ok",
    word,
    category: typeof r.category === "string" ? r.category : null,
    options,
    elapsedS: Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0,
    hour,
  };
}

// ---------------------------------------------------------------------------
// Fim: resultado
// ---------------------------------------------------------------------------
export type ChoiceResultView = {
  already_played: boolean;
  is_correct?: boolean;
  score?: number;
  truth?: string;
  chosen?: string;
  correct_pos?: number;
  chosen_pos?: number;
  time_seconds?: number;
  current_streak?: number;
  unlocked?: string[];
};

export function sanitizeChoiceFinish(raw: unknown): ChoiceResultView {
  const r = (raw ?? {}) as Record<string, unknown>;
  const status = String(r.status ?? "");
  if (status === "already_played") return { already_played: true };
  if (status === "mode_changed") throw new Error(CHOICE_MODE_CHANGED);
  if (status === "no_session") throw new Error(CHOICE_NO_SESSION);
  if (status === "hour_changed") throw new Error(CHOICE_HOUR_CHANGED);
  if (status !== "recorded") throw new Error(CHOICE_UNAVAILABLE);
  const x = (r.result ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    already_played: false,
    is_correct: x.is_correct === true,
    score: num(x.score),
    truth: String(x.truth ?? ""),
    chosen: String(x.chosen ?? ""),
    correct_pos: num(x.correct_pos),
    chosen_pos: num(x.chosen_pos),
    time_seconds: num(x.time_seconds),
    current_streak: num(x.current_streak),
    unlocked: Array.isArray(x.unlocked) ? x.unlocked.map(String) : [],
  };
}

// ---------------------------------------------------------------------------
// Telemetria: modo, resultado e latência. NUNCA palavra, alternativas,
// escolha, jogador ou hora exata.
// ---------------------------------------------------------------------------
export type ChoiceEvent = {
  kind: "daily_choice_start" | "daily_choice_finish";
  build: string | null;
  payload: { mode: "escolha"; result: string; latency_ms: number };
};

const RESULTS = new Set([
  "ok",
  "already_played",
  "mode_juiz",
  "mode_pausa",
  "sem_estoque",
  "correct",
  "wrong",
  "mode_changed",
  "no_session",
  "hour_changed",
  "error",
]);

export function choiceEvent(
  step: "start" | "finish",
  result: string,
  latencyMs: number,
  build: string | null | undefined,
): ChoiceEvent {
  return {
    kind: step === "start" ? "daily_choice_start" : "daily_choice_finish",
    build: build || null,
    payload: {
      mode: "escolha",
      result: RESULTS.has(result) ? result : "error",
      latency_ms: Math.max(0, Math.round(latencyMs)),
    },
  };
}

function startResult(raw: unknown): string {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.status === "mode")
    return r.mode === "pausa" ? "mode_pausa" : "mode_juiz";
  return String(r.status ?? "error");
}
function finishResult(raw: unknown): string {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.status === "recorded") {
    const x = (r.result ?? {}) as Record<string, unknown>;
    return x.is_correct === true ? "correct" : "wrong";
  }
  return String(r.status ?? "error");
}

type Deps = {
  logEvent: (ev: ChoiceEvent) => Promise<unknown>;
  build: string | null | undefined;
  now?: () => number;
};

async function safeLog(deps: Deps, ev: ChoiceEvent) {
  try {
    await deps.logEvent(ev);
  } catch {
    /* telemetria nunca derruba a resposta */
  }
}

/** Início do modo escolha: RPC daily_choice_start (service_role) → visão saneada. */
export async function runChoiceStart(
  deps: Deps & { start: () => Promise<unknown> },
): Promise<ChoiceStartView> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let raw: unknown;
  try {
    raw = await deps.start();
  } catch {
    await safeLog(deps, choiceEvent("start", "error", now() - t0, deps.build));
    throw new Error(CHOICE_UNAVAILABLE);
  }
  await safeLog(
    deps,
    choiceEvent("start", startResult(raw), now() - t0, deps.build),
  );
  return sanitizeChoiceStart(raw);
}

/** Fim do modo escolha: RPC daily_choice_finish (service_role) → resultado saneado. */
export async function runChoiceFinish(
  deps: Deps & { finish: () => Promise<unknown> },
): Promise<ChoiceResultView> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let raw: unknown;
  try {
    raw = await deps.finish();
  } catch {
    await safeLog(deps, choiceEvent("finish", "error", now() - t0, deps.build));
    throw new Error(CHOICE_UNAVAILABLE);
  }
  await safeLog(
    deps,
    choiceEvent("finish", finishResult(raw), now() - t0, deps.build),
  );
  return sanitizeChoiceFinish(raw);
}

// ---------------------------------------------------------------------------
// Modo do Diário (app_config.daily_mode). Valor ausente ou inválido = 'juiz'
// (o fluxo atual): nunca liga a escolha por engano.
// ---------------------------------------------------------------------------
export type DailyMode = "juiz" | "escolha" | "pausa";
export function parseDailyMode(v: unknown): DailyMode {
  return v === "escolha" || v === "pausa" ? v : "juiz";
}

/** Mesma forma da tela de alternativas (espelho de daily_choice_fmt no SQL). */
export function formatOption(s: string): string {
  const x = s.trim().replace(/[\s.;,:]+$/u, "");
  return x ? x.charAt(0).toLocaleUpperCase("pt-BR") + x.slice(1) : "";
}
