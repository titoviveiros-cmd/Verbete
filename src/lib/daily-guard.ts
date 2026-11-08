// V2 — Desafio Diário: reserva atômica ANTES da IA (05/11/2026).
// Orquestração separada do server function para ser testada sem rede nem banco.
//
// Ordem: daily_claim (banco decide: já jogou / em andamento / limites / disjuntor)
//        → só então a IA → daily_finish_ok (só o claim vigente grava, na mesma
//        transação de submit_daily_attempt_scored) ou daily_finish_fail.
// Regras:
//  * Falha do banco na reserva = NENHUMA chamada à IA (fail-closed) e a
//    tentativa NÃO é gasta.
//  * Falha da IA nunca gasta a tentativa (como antes).
//  * Modo 'desligado' (ou 'observar' sem reserva possível) = fluxo antigo,
//    idêntico ao de antes desta mudança.
//  * Nada de usuário, palpite, palavra ou definição em logs/eventos.
import {
  DAILY_EVAL_UNAVAILABLE,
  dailyFailureEvent,
  runDailyEvaluation,
  type DailyEvalResult,
  type DailyFailureEvent,
} from "./daily-evaluation";
import type { AiMode } from "../../supabase/functions/_shared/ai-mode.ts";
import { DAILY_NOW_CHOICE, type DailyMode } from "./daily-choice";

export const DAILY_IN_PROGRESS =
  "Sua resposta já está sendo avaliada — aguarde um instante e confira o resultado.";
export const DAILY_RATE_LIMITED =
  "Muitas avaliações seguidas agora. Tente de novo em alguns minutos — sua tentativa NÃO foi gasta.";
export const DAILY_HOUR_CHANGED =
  "O desafio virou de hora enquanto sua resposta era avaliada — sua tentativa NÃO foi gasta. Jogue o desafio novo.";
export const DAILY_STALE =
  "Sua avaliação demorou demais e foi descartada — sua tentativa NÃO foi gasta. Tente de novo.";
/** IA suspensa (app_config.ai_mode = 'suspenso'; docs/contencao-ia.md). */
export const DAILY_AI_PAUSED =
  "O Desafio Diário está em pausa para manutenção — sua tentativa NÃO foi gasta. Volte mais tarde!";
export const DAILY_RECORD_FAILED =
  "Não foi possível confirmar o registro agora. Atualize a página para conferir o resultado — se ele não aparecer, a tentativa NÃO foi gasta e você pode tentar de novo.";

/**
 * Prazo para as leituras do banco ANTES da IA (palavra/definição). Com a IA
 * limitada a 15 s (DAILY_BUDGET), a avaliação termina bem antes de a reserva
 * vencer (45 s): uma 2ª avaliação paga não começa com a 1ª ainda rodando.
 */
export const DAILY_PREP_TIMEOUT_MS = 8_000;

/** Resolve com `fallback` se `p` não terminar em `ms` (nunca lança por tempo). */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<T>((res) => {
    timer = setTimeout(() => res(fallback), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

export type GuardMode = "desligado" | "observar" | "aplicar";
export type ClaimStatus =
  | "bypass"
  | "claimed"
  | "pass_no_claim"
  | "already_played"
  | "in_progress"
  | "cooldown"
  | "rate_limited"
  | "provider_unavailable";

export type ClaimResponse = {
  status: ClaimStatus;
  mode?: GuardMode;
  claim_id?: string;
  /** hora do desafio calculada NO BANCO (date_trunc('hour', now())) */
  hour?: string;
  would_block?: string | null;
  already_played?: boolean;
  attempt?: unknown;
};

export type FinishOkResponse = {
  status: "recorded" | "stale" | "hour_changed";
  mode?: GuardMode;
  result?: unknown;
};

/** Falhas que não são do provedor (configuração nossa): não contam no disjuntor nem no jogador. */
const NOSSA_FALHA = new Set(["missing_key", "missing_truth"]);

const STATUS_VALIDOS: ReadonlySet<string> = new Set<ClaimStatus>([
  "bypass",
  "claimed",
  "pass_no_claim",
  "already_played",
  "in_progress",
  "cooldown",
  "rate_limited",
  "provider_unavailable",
]);

export async function runGuardedDailyAttempt<T>(deps: {
  /** daily_claim no banco. Erro do banco = lança. */
  claim: () => Promise<ClaimResponse>;
  /** IA (só é chamada se a reserva permitir). Nunca deve lançar; se lançar, conta como falha do provedor. */
  evaluate: () => Promise<DailyEvalResult>;
  /** daily_finish_ok no banco. */
  finishOk: (claimId: string, similarity: number) => Promise<FinishOkResponse>;
  /** daily_finish_fail no banco (melhor esforço). */
  finishFail: (
    claimId: string,
    kind: "provider" | "invalid" | "persist",
  ) => Promise<unknown>;
  /** Fluxo antigo de gravação (submit_daily_attempt_scored), usado em 'desligado'/'pass_no_claim'. */
  legacyRecord: (similarity: number) => Promise<T>;
  logEvent: (ev: DailyFailureEvent) => Promise<unknown>;
  build: string | null | undefined;
  /** app_config.ai_mode (com cache). Omitido = 'ligado'. */
  aiMode?: () => Promise<AiMode>;
  /** Evento 'ai_suspended' com throttle (melhor esforço). */
  logSuspended?: () => Promise<unknown>;
  /** D1: app_config.daily_mode. Omitido ou erro = 'juiz' (fluxo atual). */
  dailyMode?: () => Promise<DailyMode>;
}): Promise<T | unknown> {
  // D1 (08/11/2026): Diário em múltipla escolha ou em pausa → o envio do modo
  // juiz (site aberto antes da troca, APK 2.1.4) não reserva, não lê palavra,
  // não chama IA e NÃO gasta a tentativa. daily_mode é FIXO (D-a): não depende
  // de ai_mode.
  const dmode = await (deps.dailyMode?.() ?? Promise.resolve("juiz")).catch(
    () => "juiz",
  );
  if (dmode === "escolha") throw new Error(DAILY_NOW_CHOICE);
  if (dmode === "pausa") throw new Error(DAILY_AI_PAUSED);

  // 0) IA suspensa: pausa ANTES da reserva — nada reservado, nada gasto,
  //    nenhuma leitura de palavra/definição e nenhuma chamada ao provedor.
  const mode = await (deps.aiMode?.() ?? Promise.resolve("ligado")).catch(
    () => "ligado",
  );
  if (mode === "suspenso") {
    try {
      await deps.logSuspended?.();
    } catch {
      /* telemetria nunca derruba a resposta */
    }
    throw new Error(DAILY_AI_PAUSED);
  }

  // 1) Reserva ANTES de qualquer IA. Banco fora = sem IA (fail-closed).
  let c: ClaimResponse;
  try {
    c = await deps.claim();
  } catch {
    console.warn(
      "[daily-guard] reserva indisponível (banco): sem chamada à IA",
    );
    throw new Error(DAILY_EVAL_UNAVAILABLE);
  }
  if (!c || typeof c !== "object" || !STATUS_VALIDOS.has(String(c.status))) {
    console.warn(
      "[daily-guard] resposta de reserva inválida: sem chamada à IA",
    );
    throw new Error(DAILY_EVAL_UNAVAILABLE);
  }

  switch (c.status) {
    // ---- recusas (modo aplicar): NENHUMA chamada à IA ----
    case "already_played":
      // mesmo formato do submit_daily_attempt_scored: o cliente recarrega a revisão
      return { already_played: true, attempt: c.attempt } as unknown as T;
    case "in_progress":
      throw new Error(DAILY_IN_PROGRESS);
    case "rate_limited":
      throw new Error(DAILY_RATE_LIMITED);
    case "cooldown":
    case "provider_unavailable":
      throw new Error(DAILY_EVAL_UNAVAILABLE);

    // ---- fluxo antigo (desligado, ou observar sem reserva possível) ----
    case "bypass":
    case "pass_no_claim":
      return runDailyEvaluation({
        evaluate: deps.evaluate,
        record: deps.legacyRecord,
        logEvent: deps.logEvent,
        build: deps.build,
      });

    case "claimed":
      break;
  }

  // 2) Reserva obtida: agora sim, a IA.
  const claimId = String(c.claim_id ?? "");
  if (!claimId) throw new Error(DAILY_EVAL_UNAVAILABLE);
  let r: DailyEvalResult;
  try {
    r = await deps.evaluate();
  } catch {
    r = { ok: false, reason: "network", attempts: 0, latencyMs: 0 };
  }
  if (!r.ok) {
    const ev = dailyFailureEvent(r, deps.build);
    console.warn("[daily] avaliação indisponível", JSON.stringify(ev.payload));
    try {
      await deps.logEvent(ev);
    } catch {
      /* telemetria nunca derruba a resposta */
    }
    await deps
      .finishFail(
        claimId,
        NOSSA_FALHA.has(r.reason)
          ? "persist"
          : // resposta fora do formato pode ser induzida pelo palpite: não abre o disjuntor global
            r.reason === "invalid_response"
            ? "invalid"
            : "provider",
      )
      .catch(() => {});
    throw new Error(DAILY_EVAL_UNAVAILABLE);
  }

  // 3) Grava SÓ se o claim ainda for o vigente (atômico no banco).
  let fin: FinishOkResponse;
  try {
    fin = await deps.finishOk(claimId, r.similarity);
  } catch {
    // falha do banco ao gravar: a transação desfez tudo; libera a reserva sem punir o jogador
    await deps.finishFail(claimId, "persist").catch(() => {});
    throw new Error(DAILY_RECORD_FAILED);
  }
  if (fin?.status === "recorded") return fin.result as T;
  if (fin?.status === "hour_changed") throw new Error(DAILY_HOUR_CHANGED);
  if (fin?.status === "stale") throw new Error(DAILY_STALE);
  throw new Error(DAILY_RECORD_FAILED);
}
