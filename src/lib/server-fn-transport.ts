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

const SERVER_FN_CONTENT_TYPES = new Set([
  "application/x-tss-framed",
  "application/x-ndjson",
  "application/json",
]);
const UNEXPECTED =
  "Resposta inesperada do servidor — a ação não foi concluída.";

async function jsonBody(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.clone().text());
  } catch {
    throw new ServerFnResponseError(
      "Resposta ilegível do servidor — a ação não foi concluída.",
    );
  }
}

/**
 * Só passa resposta do PROTOCOLO das funções de servidor: o Worker marca
 * todo resultado com x-tss-serialized (ou x-tss-raw). Sem a marca — o
 * index.html do WebView, ou a marca escondida pelo navegador fora da mesma
 * origem — o cliente do TanStack devolveria a página/o JSON cru como
 * "resultado". Erro HTTP em texto/HTML segue para o cliente (que lança com
 * a mensagem do servidor); erro em JSON sem a marca vira erro aqui.
 */
export async function assertServerFnResponse(res: Response): Promise<Response> {
  const media = (res.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const serialized = !!res.headers.get("x-tss-serialized");
  if (!res.ok) {
    if (media === "application/json" && !serialized)
      throw new ServerFnResponseError(
        "O servidor recusou a ação — ela não foi concluída.",
      );
    return res;
  }
  if (res.headers.get("x-tss-raw") === "true") return res;
  if (!serialized) {
    // única exceção do protocolo: redirecionamento/notFound em JSON puro
    const body = media === "application/json" ? await jsonBody(res) : undefined;
    const flags = body as {
      isSerializedRedirect?: unknown;
      isNotFound?: unknown;
    };
    if (
      flags &&
      typeof flags === "object" &&
      (flags.isSerializedRedirect || flags.isNotFound)
    )
      return res;
    throw new ServerFnResponseError(UNEXPECTED);
  }
  if (!SERVER_FN_CONTENT_TYPES.has(media))
    throw new ServerFnResponseError(UNEXPECTED);
  if (media === "application/json") await jsonBody(res);
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
