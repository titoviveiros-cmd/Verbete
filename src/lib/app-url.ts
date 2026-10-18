// URL pública canônica do app — única fonte para meta tags, sitemap,
// links de compartilhamento e textos, no web E no app nativo. Nunca derive
// link público de location.origin: no Capacitor o WebView roda em
// https://localhost, e um build sem VITE_APP_URL já embutiu um domínio que
// não existe (Master Release Audit, VIR-03).
export const CANONICAL_APP_URL = "https://jogo.verbete.workers.dev";

const LOCAL_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$|\.local$|\.localhost$/i;

/** Aceita só https público; qualquer outra coisa cai na URL canônica. */
export function resolveAppUrl(raw: string | undefined | null): string {
  try {
    const u = new URL((raw ?? "").trim());
    if (u.protocol === "https:" && !LOCAL_HOST_RE.test(u.hostname)) {
      return u.origin;
    }
  } catch {
    /* vazio ou malformado */
  }
  return CANONICAL_APP_URL;
}

export const APP_URL: string = resolveAppUrl(
  import.meta.env.VITE_APP_URL as string | undefined,
);

/** Host sem protocolo, para exibição em textos ("jogue em ..."). */
export const APP_HOST: string = APP_URL.replace(/^https?:\/\//, "");

/** Link de convite para uma sala (abre o app pelo App Link no Android). */
export function roomInviteUrl(code: string): string {
  return `${APP_URL}/?join=${encodeURIComponent(code)}`;
}
