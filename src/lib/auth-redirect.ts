// Endereço canônico de RETORNO da autenticação (OAuth do Google e links de
// confirmação por e-mail) — única fonte; nenhum fluxo de auth monta o seu.
//
// Web: a origem que serve o app (em release, só https público — localhost de
// um build de release cai na URL canônica).
// App nativo (bundle `vite build --mode capacitor`): o WebView roda em
// https://localhost, que fora dele não existe. O retorno vem pelo esquema
// próprio do Android (custom_url_scheme = appId, intent-filter no Manifest);
// o código PKCE que chega nele só vira sessão com o verificador guardado no
// próprio app (ver native-auth.ts e o flowType do client).
import { resolveAppUrl } from "./app-url";

export const NATIVE_AUTH_SCHEME = "app.verbete.game";
export const NATIVE_AUTH_CALLBACK = `${NATIVE_AUTH_SCHEME}://auth/callback`;

/** Bundle do app nativo: decidido no build (constante — o Vite elimina o outro ramo). */
export const IS_NATIVE_BUILD: boolean = import.meta.env.MODE === "capacitor";

export function authRedirectFor(env: {
  native: boolean;
  dev: boolean;
  origin: string | null;
}): string {
  if (env.native) return NATIVE_AUTH_CALLBACK;
  if (env.dev && env.origin) return env.origin;
  return resolveAppUrl(env.origin);
}

export function getAuthRedirectUrl(): string {
  return authRedirectFor({
    native: IS_NATIVE_BUILD,
    dev: import.meta.env.DEV,
    origin: typeof window !== "undefined" ? window.location.origin : null,
  });
}
