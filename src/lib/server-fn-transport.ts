// Transporte das funções de servidor (TanStack Start) — site e app nativo.
//
// App nativo (Capacitor): o WebView roda em https://localhost; a chamada
// relativa /_serverFn/... ia para o servidor LOCAL do app, que devolve o
// index.html com 200 (html5mode) — e o cliente do TanStack aceitava essa
// resposta como resultado: "Excluir conta" fazia logout sem excluir nada
// (Red Team da RC Android 2.1.0). No app a chamada vai para a URL pública do
// Worker (APP_URL); no site, nada muda (mesma origem). E, em qualquer
// ambiente, nenhuma resposta vale só por ser HTTP 200: precisa ser do
// protocolo das funções de servidor e, quando JSON, JSON válido.
import { APP_URL } from "./app-url";
import { IS_NATIVE_BUILD } from "./auth-redirect";

export class ServerFnResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerFnResponseError";
  }
}

/** Caminho relativo do app → URL absoluta do Worker, só no app nativo. */
export function resolveServerFnUrl(
  url: string,
  native: boolean = IS_NATIVE_BUILD,
  base: string = APP_URL,
): string {
  if (!native) return url;
  // só caminhos do próprio app ("/_serverFn/..."); URL absoluta ou "//host"
  // nunca é reescrita
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  return new URL(url, base).toString();
}

const SERVER_FN_CONTENT_TYPES = [
  "application/x-tss-framed",
  "application/x-ndjson",
  "application/json",
];

/**
 * Resposta 2xx só passa se for do protocolo das funções de servidor. Erros
 * HTTP (401/403/500…) seguem para o cliente do TanStack, que os transforma
 * em erro com a mensagem do servidor.
 */
export async function assertServerFnResponse(res: Response): Promise<Response> {
  if (!res.ok) return res;
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!SERVER_FN_CONTENT_TYPES.some((t) => type.includes(t))) {
    throw new ServerFnResponseError(
      "Resposta inesperada do servidor — a ação não foi concluída.",
    );
  }
  if (type.includes("application/json")) {
    try {
      JSON.parse(await res.clone().text());
    } catch {
      throw new ServerFnResponseError(
        "Resposta ilegível do servidor — a ação não foi concluída.",
      );
    }
  }
  return res;
}

/** fetch das funções de servidor (createStart → serverFns.fetch). */
export async function serverFnFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res =
    typeof input === "string" || input instanceof URL
      ? await fetch(resolveServerFnUrl(input.toString()), init)
      : await fetch(new Request(resolveServerFnUrl(input.url), input), init);
  return assertServerFnResponse(res);
}

/**
 * Resultado de operação: só um objeto simples com `ok: true` é sucesso. Uma
 * `Response` (o falso sucesso antigo) também tem `ok === true` — por isso a
 * exigência de objeto simples, como o que a função de servidor devolve.
 */
export function expectOk<T extends { ok?: unknown }>(
  result: T | null | undefined,
  message: string,
): T {
  const plain =
    !!result &&
    typeof result === "object" &&
    Object.getPrototypeOf(result) === Object.prototype;
  if (!plain || result.ok !== true) throw new ServerFnResponseError(message);
  return result;
}
