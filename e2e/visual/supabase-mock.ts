// Backend simulado para os testes VISUAIS: intercepta no navegador TODA
// chamada ao Supabase (REST, RPC, auth, edge functions e o WebSocket do
// realtime) e responde com a partida fictícia de fixtures.ts. Nada sai da
// máquina: escrita vira resposta vazia e qualquer rota desconhecida do
// Supabase é abortada — o teste visual nunca toca um banco de verdade.
import { readFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";

export type Json =
  null | boolean | number | string | Json[] | { [k: string]: Json };

export type MockBackend = {
  /** Resposta por nome de RPC (`/rest/v1/rpc/<nome>`). Ausente = null. */
  rpc: Record<string, Json>;
  /** Linhas por tabela (`/rest/v1/<tabela>`), filtradas por eq/in simples. */
  tables: Record<string, Array<Record<string, Json>>>;
  /** Usuário logado (Diário, Perfil). Sem ele a sessão fica vazia. */
  user?: { id: string; email?: string; name?: string } | null;
};

function supabaseUrl(): string {
  if (process.env.VITE_SUPABASE_URL) return process.env.VITE_SUPABASE_URL;
  try {
    const env = readFileSync(".env", "utf8");
    const m = env.match(/^VITE_SUPABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
    if (m?.[1]) return m[1];
  } catch {
    /* sem .env: cai no padrão do Supabase local */
  }
  return "http://127.0.0.1:54321";
}

/** Chave de sessão que o supabase-js usa no localStorage. */
function authStorageKey(url: string): string {
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeSession(user: NonNullable<MockBackend["user"]>) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const authUser = {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email ?? "visual@exemplo.invalid",
    is_anonymous: false,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { name: user.name ?? "Jogador" },
    created_at: "2026-01-01T00:00:00Z",
  };
  const token = [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({ sub: user.id, role: "authenticated", aud: "authenticated", exp }),
    "assinatura-falsa",
  ].join(".");
  return {
    access_token: token,
    refresh_token: "refresh-falso",
    token_type: "bearer",
    expires_in: 60 * 60 * 24 * 30,
    expires_at: exp,
    user: authUser,
  };
}

/** Filtros simples do PostgREST usados pelo app: col=eq.x, col=in.(a,b), col=is.null. */
function applyFilters(
  rows: Array<Record<string, Json>>,
  params: URLSearchParams,
): Array<Record<string, Json>> {
  let out = rows;
  for (const [col, raw] of params) {
    if (["select", "order", "limit", "offset", "or", "and"].includes(col))
      continue;
    const m = raw.match(/^(not\.)?(eq|in|is|neq)\.(.*)$/);
    if (!m) continue;
    const [, not, op, val] = m;
    const test = (v: Json): boolean => {
      if (op === "eq") return String(v) === val;
      if (op === "neq") return String(v) !== val;
      if (op === "is")
        return val === "null"
          ? v === null || v === undefined
          : String(v) === val;
      const list = (val ?? "")
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map((s) => s.replace(/^"|"$/g, ""));
      return list.includes(String(v));
    };
    out = out.filter((r) =>
      not ? !test(r[col] ?? null) : test(r[col] ?? null),
    );
  }
  return out;
}

export type MockLog = { calls: string[]; aborted: string[] };

export async function installSupabaseMock(
  page: Page,
  backend: MockBackend,
): Promise<MockLog> {
  const base = supabaseUrl();
  const origin = new URL(base).origin;
  const log: MockLog = { calls: [], aborted: [] };

  // Sessão antes do 1º script do app: o useAuth lê o localStorage na hora.
  const session = backend.user ? fakeSession(backend.user) : null;
  await page.addInitScript(
    ([key, value]) => {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    },
    [authStorageKey(base), session ? JSON.stringify(session) : ""] as const,
  );

  const json = (
    route: Route,
    body: Json,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*", ...headers },
      body: JSON.stringify(body),
    });

  await page.route(
    (url) => url.origin === origin,
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      log.calls.push(`${req.method()} ${path}`);
      if (req.method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
            "access-control-allow-methods":
              "GET,POST,PATCH,DELETE,HEAD,OPTIONS",
          },
        });
      }

      if (path.startsWith("/rest/v1/rpc/")) {
        const fn = path.slice("/rest/v1/rpc/".length);
        return json(
          route,
          fn in backend.rpc ? (backend.rpc[fn] as Json) : null,
        );
      }
      if (path.startsWith("/rest/v1/")) {
        if (req.method() !== "GET" && req.method() !== "HEAD") {
          // Escrita direta em tabela: aceita e descarta.
          return route.fulfill({
            status: 204,
            headers: { "access-control-allow-origin": "*" },
          });
        }
        const table = path.slice("/rest/v1/".length);
        const rows = applyFilters(
          backend.tables[table] ?? [],
          url.searchParams,
        );
        const accept = req.headers()["accept"] ?? "";
        if (accept.includes("vnd.pgrst.object")) {
          if (rows.length === 0) {
            return json(route, { code: "PGRST116", message: "0 rows" }, 406);
          }
          return json(route, rows[0] as Json);
        }
        return json(route, rows as Json, 200, {
          "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`,
        });
      }
      if (path.startsWith("/auth/v1/")) {
        if (path.endsWith("/user")) {
          return session
            ? json(route, session.user as unknown as Json)
            : json(route, { msg: "no user" }, 401);
        }
        if (path.endsWith("/logout")) return route.fulfill({ status: 204 });
        // signup anônimo / refresh: devolve a mesma sessão (ou uma anônima).
        const s =
          session ??
          fakeSession({ id: "00000000-0000-4000-8000-0000000000aa" });
        return json(route, s as unknown as Json);
      }
      if (path.startsWith("/functions/v1/")) return json(route, {});
      log.aborted.push(`${req.method()} ${path}`);
      return route.abort();
    },
  );

  // Realtime (protocolo 2.0.0: [join_ref, ref, topic, event, payload]).
  // Responde "ok" a join/heartbeat/presence; nunca empurra mudanças —
  // o estado da tela fica congelado na fixture.
  await page.routeWebSocket(
    (url) => url.pathname.includes("/realtime/v1/websocket"),
    (ws) => {
      ws.onMessage((raw) => {
        if (typeof raw !== "string") {
          // Broadcast binário do app (kind 3: userBroadcastPush). Com ack
          // (o ping do LatencyIndicator), o servidor responde phx_reply ok.
          const b = Buffer.from(raw);
          if (b[0] !== 3 || b.length < 7) return;
          const [jr, rf, tp] = [b[1]!, b[2]!, b[3]!];
          let o = 7;
          const joinRef = b.subarray(o, (o += jr)).toString("utf8");
          const ref = b.subarray(o, (o += rf)).toString("utf8");
          const topic = b.subarray(o, (o += tp)).toString("utf8");
          if (ref)
            ws.send(
              JSON.stringify([
                joinRef || null,
                ref,
                topic,
                "phx_reply",
                { status: "ok", response: {} },
              ]),
            );
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        const [joinRef, ref, topic, event] = msg as [
          string | null,
          string | null,
          string,
          string,
        ];
        if (ref === null) return;
        if (
          [
            "phx_join",
            "heartbeat",
            "presence",
            "access_token",
            "phx_leave",
          ].includes(event)
        ) {
          ws.send(
            JSON.stringify([
              joinRef,
              ref,
              topic,
              "phx_reply",
              { status: "ok", response: {} },
            ]),
          );
        }
      });
    },
  );

  return log;
}
