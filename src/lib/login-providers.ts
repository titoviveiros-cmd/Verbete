// Quais provedores de login aparecem em cada plataforma.
//
// App Store, diretriz 4.8 (Login Services): app que oferece login social de
// terceiros (Google) precisa oferecer também uma opção equivalente que limite
// os dados a nome+e-mail e permita esconder o e-mail (ex.: Entrar com a Apple).
// Enquanto não existir conta Apple Developer + Sign in with Apple configurado
// no Supabase, o app iOS mostra só e-mail/senha e convidado (conta própria —
// exceção prevista na 4.8). Web e Android seguem com o Google.
import { Capacitor } from "@capacitor/core";

/** Regra pura (testável): o Google só fica de fora no app iOS. */
export function googleLoginAvailableOn(platform: string): boolean {
  return platform !== "ios";
}

/** Plataforma atual ("web" | "android" | "ios"). */
export function isGoogleLoginAvailable(): boolean {
  return googleLoginAvailableOn(Capacitor.getPlatform());
}
