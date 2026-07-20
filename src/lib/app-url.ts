// URL pública canônica do app — única fonte para meta tags, sitemap,
// links de compartilhamento e textos. Configure VITE_APP_URL no ambiente
// de build (ex.: https://verbete.app); o fallback só existe para builds
// locais sem env.
export const APP_URL: string = (
  (import.meta.env.VITE_APP_URL as string | undefined) ?? "https://verbete.app"
).replace(/\/+$/, "");

/** Host sem protocolo, para exibição em textos ("jogue em verbete.app"). */
export const APP_HOST: string = APP_URL.replace(/^https?:\/\//, "");
