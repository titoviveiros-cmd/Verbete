// CORS do Worker para o app nativo (RC Android 2.1.0). O WebView do
// Capacitor no Android roda na origem https://localhost (CapConfig: hostname
// "localhost" + esquema "https"); as funções de servidor agora são chamadas
// na URL pública do Worker, então o navegador do app precisa de permissão
// para LER a resposta. Só essa origem, só em /_serverFn/, sem curinga e sem
// credenciais (cookies): a autorização continua no token Bearer do Supabase
// validado em cada função (requireSupabaseAuth) — a origem não autoriza nada.
export const NATIVE_APP_ORIGINS: ReadonlySet<string> = new Set([
  "https://localhost",
]);
const SERVER_FN_PREFIX = "/_serverFn/";

export type NativeCors =
  | { kind: "none" }
  | { kind: "preflight"; response: Response }
  | { kind: "headers"; headers: Record<string, string> };

export function nativeCorsFor(request: Request): NativeCors {
  const origin = request.headers.get("origin");
  if (!origin || !NATIVE_APP_ORIGINS.has(origin)) return { kind: "none" };
  if (!new URL(request.url).pathname.startsWith(SERVER_FN_PREFIX))
    return { kind: "none" };
  const headers = { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  if (request.method === "OPTIONS") {
    return {
      kind: "preflight",
      response: new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "authorization, content-type, accept, x-tsr-serverfn",
          "Access-Control-Max-Age": "600",
        },
      }),
    };
  }
  return { kind: "headers", headers };
}

/** Copia a resposta com os cabeçalhos de CORS (cabeçalhos podem ser imutáveis). */
export function withCors(
  response: Response,
  headers: Record<string, string>,
): Response {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) {
    const prev = k === "Vary" ? out.headers.get("Vary") : null;
    out.headers.set(
      k,
      prev && !/\borigin\b/i.test(prev) ? `${prev}, ${v}` : (prev ?? v),
    );
  }
  return out;
}
