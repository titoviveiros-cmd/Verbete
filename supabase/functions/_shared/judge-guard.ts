// V3 mínima (05/11/2026) — score-similarity sem julgamento repetido.
// Sem APIs do Deno: testado no Vitest (src/lib/__tests__/room-guard.test.ts).
//
// Quem chama a edge é o BANCO (fire_round_judge via pg_net, chave anon), só
// para rodada com judged_at NULL, até 3 tentativas nos primeiros 15 min
// (retry_round_judgments). Mas a edge é pública (verify_jwt=false): qualquer
// um podia repetir o pedido de uma rodada já julgada e gastar até 4 chamadas
// do Gemini a cada vez. Nenhum caminho legítimo julga de novo uma rodada:
//   • judged_at preenchido → o juiz já respondeu com sucesso (ou não havia
//     candidatas);
//   • judge_attempts >= 4 → o reenvio desistiu (judge_gave_up);
//   • pontuada há mais de STALE_MS → fora da janela do reenvio (15 min).
// Sob o mesmo interruptor das edges dos bots (app_config.bots_auth_mode):
// 'observar' só registra, 'aplicar' devolve { matches: [] } sem IA e sem
// "error" (para o reenvio do banco, isso é "julgada", nunca nova tentativa).

import type { GuardMode } from "./room-guard.ts";

/** Janela do reenvio (15 min) + folga larga para o pg_net e o relógio. */
export const JUDGE_STALE_MS = 30 * 60 * 1000;

export type JudgeSkipReason =
  | "already_judged"
  | "gave_up"
  | "stale"
  | "in_progress";

export type JudgeRoundState = {
  judged_at?: string | null;
  judge_attempts?: number | null;
  scored_at?: string | null;
};

export function judgeSkipReason(
  r: JudgeRoundState,
  nowMs: number,
): JudgeSkipReason | null {
  if (r.judged_at) return "already_judged";
  if (Number(r.judge_attempts ?? 0) >= 4) return "gave_up";
  const scored = r.scored_at ? Date.parse(r.scored_at) : NaN;
  if (Number.isFinite(scored) && nowMs - scored > JUDGE_STALE_MS) return "stale";
  return null;
}

export type JudgeGuard = {
  mode: GuardMode;
  reason: JudgeSkipReason | null;
  /** true só em 'aplicar': responde sem chamar a IA. */
  skip: boolean;
};

export function decideJudge(
  mode: GuardMode,
  r: JudgeRoundState,
  nowMs: number,
): JudgeGuard {
  if (mode === "desligado") return { mode, reason: null, skip: false };
  const reason = judgeSkipReason(r, nowMs);
  return { mode, reason, skip: mode === "aplicar" && reason !== null };
}

/**
 * Reserva da rodada (judge_lease_take, migration V3): uma avaliação por vez.
 * `took` = true (reservou), false (outra avaliação em andamento) ou null
 * (falha ao reservar → segue SEM reserva: a reserva protege custo/justiça,
 * nunca pode impedir o julgamento legítimo do banco).
 * Em 'aplicar', a ocupada responde COM "error" (judge_in_progress): para o
 * reenvio do banco é falha, e ele tenta de novo depois — se a outra avaliação
 * der certo, a rodada já estará julgada e nada se repete.
 */
export function decideLease(
  mode: GuardMode,
  took: boolean | null,
): JudgeGuard {
  if (mode === "desligado" || took !== false)
    return { mode, reason: null, skip: false };
  return { mode, reason: "in_progress", skip: mode === "aplicar" };
}

export function judgeGuardEvent(g: JudgeGuard) {
  return {
    kind: "ai_guard" as const,
    payload: {
      fn: "score-similarity",
      mode: g.mode,
      decision: g.reason ?? "ok",
      blocked: g.skip,
    },
  };
}
