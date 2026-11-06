// V3 mínima (05/11/2026) — guarda das edges de IA dos bots
// (bot-definitions e bot-definitions-v2). Sem APIs do Deno nem imports por
// URL: a decisão inteira é testada no Vitest
// (src/lib/__tests__/room-guard.test.ts). O acesso ao banco vive em
// ./room-guard-deps.ts (só Deno).
//
// Antes: verify_jwt=false e o único gate era o word_id ser a palavra corrente
// de alguma sala em escrita — e `rooms` é legível por anon. Qualquer um podia
// chamar em laço (até 3 chamadas Gemini por pedido na v2).
//
// Agora (sob app_config.bots_auth_mode):
//   1. sessão: o token do pedido precisa ser de um usuário (conta OU convidado
//      anônimo — o client sempre abre sessão antes de entrar numa sala);
//   2. membro: esse usuário tem linha em `players` DAQUELA sala, não expulso;
//   3. cota: no máximo N pedidos que chegam à IA por sala/rodada (ai_quota).
// Modos: 'desligado' (fluxo antigo, interruptor de rollback) · 'observar'
// (PADRÃO: decide e REGISTRA o que bloquearia, nunca bloqueia) · 'aplicar'.
// Valor ausente ou inválido = 'observar' — nunca vira 'aplicar' sozinho.
// Telemetria: kind 'ai_guard', só função, modo, decisão e se bloqueou —
// nunca usuário, sala, palavra ou texto.

export type GuardMode = "desligado" | "observar" | "aplicar";

export const GUARD_MODE_KEY = "bots_auth_mode";
export const ROUND_LIMIT_KEY = "bots_ai_round_limit";
/** 12 jogadores × (💡 + sugestão automática + recargas) + bots do host, com folga. */
export const DEFAULT_ROUND_LIMIT = 60;
/** Nunca abaixo disso (config errada não pode derrubar os bots de uma sala cheia). */
export const MIN_ROUND_LIMIT = 20;
export const MAX_ROUND_LIMIT = 1000;

export function parseGuardMode(v: unknown): GuardMode {
  return v === "desligado" || v === "observar" || v === "aplicar"
    ? v
    : "observar";
}

export function parseRoundLimit(v: unknown): number {
  const s = typeof v === "string" ? v.trim() : "";
  if (!/^\d{1,6}$/.test(s)) return DEFAULT_ROUND_LIMIT;
  return Math.min(MAX_ROUND_LIMIT, Math.max(MIN_ROUND_LIMIT, Number(s)));
}

/** Token "Bearer x" do cabeçalho Authorization ("" se ausente). */
export function bearerToken(header: string | null | undefined): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header ?? ""));
  return m?.[1] ?? "";
}

/** Chave do contador em public.ai_quota — montada no BANCO por
 *  bots_quota_take (migration V3, janela de 1 dia); aqui só para conferência. */
export function quotaKey(roomId: string, round: number): string {
  return `bots_round:${roomId}:${round}`;
}

/** Quem é o chamador: usuário válido, sem sessão (sem token, chave anon,
 *  token inválido/vencido) ou serviço de auth fora do ar. */
export type Identity =
  | { kind: "user"; userId: string }
  | { kind: "none" }
  | { kind: "error" };

export type GuardDecision =
  | "ok"
  | "room_required"
  | "no_session"
  | "auth_unavailable"
  | "not_member"
  | "quota_exceeded"
  | "guard_error";

export const DECISION_STATUS: Record<GuardDecision, number> = {
  ok: 200,
  room_required: 400,
  no_session: 401,
  auth_unavailable: 503,
  not_member: 403,
  quota_exceeded: 429,
  guard_error: 503,
};

/** Etapa que falhou num 'guard_error' (diagnóstico; nunca dado pessoal). */
export type GuardStage = "identify" | "member" | "quota";

export type GuardResult = {
  mode: GuardMode;
  decision: GuardDecision;
  /** true só no modo 'aplicar' com decisão ≠ ok: a edge responde `status` sem IA. */
  block: boolean;
  status: number;
  /** Só em 'guard_error': etapa e código do erro (ex.: 42501 = sem permissão). */
  stage?: GuardStage;
  errorCode?: string;
};

/** Acesso ao banco/auth, injetado (Deno em produção, falsos nos testes). */
export type GuardDeps = {
  readConfig: (key: string) => Promise<string | null>;
  identify: (token: string) => Promise<Identity>;
  isMember: (roomId: string, userId: string) => Promise<boolean>;
  /** Soma 1 ao contador da sala/rodada e devolve o total (atômico no banco). */
  takeQuota: (roomId: string, round: number) => Promise<number>;
};

export type GuardInput = {
  token: string;
  /** room_id enviado pelo client ("" se ausente/inválido). */
  askedRoomId: string;
  /** Sala que tem o word_id ativo — já filtrada pelo room_id pedido. */
  roomId: string;
  round: number;
};

function result(mode: GuardMode, decision: GuardDecision): GuardResult {
  return {
    mode,
    decision,
    block: mode === "aplicar" && decision !== "ok",
    status: DECISION_STATUS[decision],
  };
}

/**
 * Decide se o pedido segue para a IA. Nunca lança: erro de banco/auth vira
 * 'guard_error' (bloqueia só em 'aplicar'; em 'observar' só registra).
 * A cota só conta pedidos que passariam pela identidade — exatamente os que
 * chegariam à IA no modo 'aplicar'.
 */
export async function runRoomGuard(
  deps: GuardDeps,
  input: GuardInput,
): Promise<GuardResult> {
  let mode: GuardMode = "observar";
  try {
    mode = parseGuardMode(await deps.readConfig(GUARD_MODE_KEY));
  } catch {
    mode = "observar"; // leitura falhou: nunca 'aplicar' por acidente
  }
  if (mode === "desligado") return result(mode, "ok");
  let stage: GuardStage = "identify";
  try {
    if (!input.askedRoomId) return result(mode, "room_required");
    if (!input.token) return result(mode, "no_session");
    const who = await deps.identify(input.token);
    if (who.kind === "none") return result(mode, "no_session");
    if (who.kind === "error") return result(mode, "auth_unavailable");
    stage = "member";
    if (!(await deps.isMember(input.roomId, who.userId)))
      return result(mode, "not_member");
    stage = "quota";
    const limit = parseRoundLimit(
      await deps.readConfig(ROUND_LIMIT_KEY).catch(() => null),
    );
    const used = await deps.takeQuota(input.roomId, input.round);
    if (!Number.isInteger(used) || used < 1)
      throw new Error("contador da cota inválido");
    if (used > limit) return result(mode, "quota_exceeded");
    return result(mode, "ok");
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return {
      ...result(mode, "guard_error"),
      stage,
      ...(typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)
        ? { errorCode: code }
        : {}),
    };
  }
}

/** Corpo da resposta de bloqueio — mesmo formato vazio que o client já trata. */
export function blockedBody(decision: GuardDecision) {
  return { error: decision, definitions: [], fallbacks: [] };
}

/** Evento só quando a decisão não é 'ok' (o 'ok' já sai no bot_ai_*). */
export function guardEvent(fn: string, g: GuardResult) {
  return {
    kind: "ai_guard" as const,
    payload: {
      fn,
      mode: g.mode,
      decision: g.decision,
      blocked: g.block,
      ...(g.stage ? { stage: g.stage } : {}),
      ...(g.errorCode ? { error_code: g.errorCode } : {}),
    },
  };
}
