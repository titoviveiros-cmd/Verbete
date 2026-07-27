// Fase 8 — telemetria de saúde própria (sem terceiros, sem dados pessoais).
// Envia eventos anônimos p/ public.log_ops_event via REST direto (fetch puro,
// sem supabase-js — evita ciclo de import e funciona mesmo se o client SDK
// estiver quebrado, que é exatamente quando mais precisamos do relato).
//
// Privacidade: session_key/room_hash são hashes NÃO reversíveis; payloads
// carregam só mensagem/stack truncados e a URL da rota (sem query strings).

const MAX_PER_MINUTE = 10;
const DEDUPE_WINDOW_MS = 60_000;

let sentTimestamps: number[] = [];
const recentMessages = new Map<string, number>();

// djb2 — suficiente p/ agrupar sem identificar
export function opsHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function env(name: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)[name];
}

let currentRoomCode: string | null = null;
/** Sala atual (código) — setada pelo use-room p/ contextualizar eventos. */
export function setOpsRoom(code: string | null) {
  currentRoomCode = code;
}

export type OpsKind =
  "client_error" | "boundary_crash" | "rpc_failure" | "reconnect";

export function reportOpsEvent(
  kind: OpsKind,
  payload: Record<string, unknown>,
): void {
  try {
    if (typeof window === "undefined") return;
    const url = env("VITE_SUPABASE_URL");
    const key = env("VITE_SUPABASE_PUBLISHABLE_KEY");
    if (!url || !key) return;

    // Throttle: no máx. 10/min por aba
    const now = Date.now();
    sentTimestamps = sentTimestamps.filter((t) => now - t < 60_000);
    if (sentTimestamps.length >= MAX_PER_MINUTE) return;

    // Dedupe: mesmo evento repetido em 60s vira 1
    const dedupeKey = kind + ":" + JSON.stringify(payload).slice(0, 200);
    const last = recentMessages.get(dedupeKey);
    if (last && now - last < DEDUPE_WINDOW_MS) return;
    recentMessages.set(dedupeKey, now);
    sentTimestamps.push(now);

    let sessionKey: string | null = null;
    try {
      const pid = localStorage.getItem("verbete:player-id");
      if (pid) sessionKey = opsHash(pid);
    } catch {
      /* storage indisponível */
    }

    void fetch(`${url}/rest/v1/rpc/log_ops_event`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      keepalive: true,
      body: JSON.stringify({
        p_kind: kind,
        p_payload: payload,
        p_session_key: sessionKey,
        p_room_hash: currentRoomCode ? opsHash(currentRoomCode) : null,
        p_build: env("VITE_BUILD_ID") ?? "dev",
      }),
    }).catch(() => {
      /* telemetria nunca pode quebrar o jogo */
    });
  } catch {
    /* idem */
  }
}

function describeError(err: unknown): Record<string, unknown> {
  const e = err instanceof Error ? err : new Error(String(err ?? "unknown"));
  return {
    message: String(e.message).slice(0, 300),
    stack: String(e.stack ?? "").slice(0, 900),
    route: typeof location !== "undefined" ? location.pathname : "",
  };
}

let installed = false;
/** Captura global de erros não tratados (uma vez por aba). */
export function installOpsCapture() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    reportOpsEvent("client_error", describeError(event.error ?? event.message));
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportOpsEvent("client_error", {
      ...describeError(event.reason),
      unhandled_rejection: true,
    });
  });
}
