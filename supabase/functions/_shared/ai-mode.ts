// Contenção da IA (05/11/2026): interruptor app_config.ai_mode.
//   'ligado'   → comportamento de sempre (PADRÃO; ausente ou inválido = ligado)
//   'suspenso' → NENHUMA chamada ao provedor de IA: o juiz do 🧠 marca a rodada
//                como julgada sem bônus, os bots e os 💡/🤖 ficam nas reservas e
//                o Desafio Diário mostra a pausa (sem gastar tentativa).
// Usado pelas edge functions (Deno) e pelo Worker (Diário). Sem APIs do Deno
// nem do Node: coberto pelos testes Vitest em src/lib/__tests__/ai-mode.test.ts.
// Ativação/rollback e riscos: docs/contencao-ia.md.

export type AiMode = "ligado" | "suspenso";

export const AI_MODE_KEY = "ai_mode";
/** Cache curto por isolate: uma leitura do banco a cada 30 s, no máximo. */
export const AI_MODE_CACHE_MS = 30_000;
/** No máximo 1 evento 'ai_suspended' por função a cada 10 min. */
export const AI_SUSPENDED_EVENT_WINDOW_MS = 10 * 60_000;

/**
 * Corte que NÃO depende do banco (06/11/2026): variável de ambiente/segredo da
 * edge ou do Worker. Com ela, o modo é 'suspenso' sem ler app_config — vale
 * mesmo com o Supabase fora ou num isolate novo (falha FECHADA).
 */
export const AI_FORCE_SUSPEND_ENV = "AI_FORCE_SUSPEND";
/** Chave do provedor atual; sem ela não há como chamar a IA → suspenso, sem erro. */
export const AI_PROVIDER_KEY_ENV = "GEMINI_API_KEY";

export function isForcedSuspension(v: unknown): boolean {
  return (
    typeof v === "string" &&
    ["1", "true", "sim", "suspenso"].includes(v.trim().toLowerCase())
  );
}

/**
 * Suspensão forçada pelo ambiente: AI_FORCE_SUSPEND ligado OU chave do
 * provedor ausente/vazia (revogar/remover a chave = mesma pausa limpa do
 * interruptor, em vez de erro 5xx e reenvios).
 */
export function forcedSuspensionFrom(
  get: (k: string) => string | undefined | null,
): boolean {
  return (
    isForcedSuspension(get(AI_FORCE_SUSPEND_ENV)) ||
    !String(get(AI_PROVIDER_KEY_ENV) ?? "").trim()
  );
}

/** Só 'suspenso' (sem diferença de caixa/espaços) suspende; o resto = ligado. */
export function parseAiMode(v: unknown): AiMode {
  return typeof v === "string" && v.trim().toLowerCase() === "suspenso"
    ? "suspenso"
    : "ligado";
}

/**
 * Leitor com cache curto. Ordem: (1) suspensão forçada pelo ambiente
 * (opts.forced) → 'suspenso' sem tocar no banco; (2) app_config com cache.
 * Falha de leitura do banco → último valor conhecido neste isolate; sem
 * nenhum → 'ligado' (falha aberta do interruptor do BANCO: ele nunca derruba
 * o jogo sozinho). Corte garantido com o banco fora = AI_FORCE_SUSPEND ou
 * remover a chave do provedor (docs/contencao-ia.md, "Corte completo").
 */
export function createAiModeReader(
  opts: { ttlMs?: number; now?: () => number; forced?: () => boolean } = {},
) {
  const ttl = opts.ttlMs ?? AI_MODE_CACHE_MS;
  const now = opts.now ?? Date.now;
  let cached: { mode: AiMode; at: number } | null = null;
  return async function readAiMode(
    load: () => Promise<unknown>,
  ): Promise<AiMode> {
    try {
      if (opts.forced?.()) return "suspenso";
    } catch {
      /* ambiente ilegível: segue para o banco */
    }
    const t = now();
    if (cached && t - cached.at < ttl) return cached.mode;
    try {
      const mode = parseAiMode(await load());
      cached = { mode, at: t };
      return mode;
    } catch {
      return cached?.mode ?? "ligado";
    }
  };
}

export type AiSuspendedEvent = {
  kind: "ai_suspended";
  payload: { fn: string; mode: "suspenso" };
};

/** Só o nome da função: nunca sala, jogador, palavra ou texto. */
export function aiSuspendedEvent(fn: string): AiSuspendedEvent {
  return { kind: "ai_suspended", payload: { fn, mode: "suspenso" } };
}

/**
 * Evento 'ai_suspended' com throttle: em memória (por isolate) e no banco
 * (já existe um desta função na janela? não grava). Nunca lança.
 */
export function createSuspendedLogger(
  opts: { windowMs?: number; now?: () => number } = {},
) {
  const windowMs = opts.windowMs ?? AI_SUSPENDED_EVENT_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const last = new Map<string, number>();
  return async function logSuspended(
    fn: string,
    io: {
      /** Já há evento desta função desde `sinceIso`? */
      recent: (fn: string, sinceIso: string) => Promise<boolean>;
      insert: (ev: AiSuspendedEvent) => Promise<unknown>;
    },
  ): Promise<boolean> {
    const t = now();
    const prev = last.get(fn);
    if (prev !== undefined && t - prev < windowMs) return false;
    last.set(fn, t);
    let seen = false;
    try {
      seen = await io.recent(fn, new Date(t - windowMs).toISOString());
    } catch {
      /* sem a consulta, vale só o throttle em memória */
    }
    if (seen) return false;
    try {
      await io.insert(aiSuspendedEvent(fn));
      return true;
    } catch {
      return false; // telemetria nunca derruba o pedido
    }
  };
}

/**
 * Juiz do 🧠 com a IA suspensa: marca a rodada como julgada (o reenvio do
 * banco não dispara de novo) e responde 200 SEM "error" — se a marca falhar,
 * o retry_round_judgments lê essa resposta e marca. Sem bônus nem "Quase lá".
 */
export async function skipJudgeSuspended(deps: {
  markJudged: () => Promise<unknown>;
  logSuspended: () => Promise<unknown>;
}): Promise<{ matches: string[]; skipped: "ai_suspended" }> {
  try {
    await deps.markJudged();
  } catch {
    /* o cron marca pela resposta 200 sem erro */
  }
  try {
    await deps.logSuspended();
  } catch {
    /* telemetria */
  }
  return { matches: [], skipped: "ai_suspended" };
}

// ---- E/S com o supabase-js das edges (service role) -------------------------
// Tipo estrutural mínimo: o mesmo arquivo é importado pelo Vitest e pelo Deno.
// deno-lint-ignore no-explicit-any
type Db = { from: (table: string) => any };

/** Valor cru de app_config.ai_mode (erro do banco = lança → leitor decide). */
export async function loadAiModeValue(db: Db): Promise<unknown> {
  const { data, error } = await db
    .from("app_config")
    .select("value")
    .eq("key", AI_MODE_KEY)
    .maybeSingle();
  if (error) throw new Error(`app_config ${error.code ?? "?"}`);
  return (data as { value?: unknown } | null)?.value;
}

export function suspendedEventIO(db: Db) {
  return {
    recent: async (fn: string, sinceIso: string) => {
      const { data, error } = await db
        .from("ops_events")
        .select("id")
        .eq("kind", "ai_suspended")
        .eq("payload->>fn", fn)
        .gte("at", sinceIso)
        .limit(1);
      if (error) throw new Error(`ops_events ${error.code ?? "?"}`);
      return Array.isArray(data) && data.length > 0;
    },
    insert: async (ev: AiSuspendedEvent) => {
      const { error } = await db.from("ops_events").insert(ev);
      if (error) throw new Error(`ops_events ${error.code ?? "?"}`);
    },
  };
}
