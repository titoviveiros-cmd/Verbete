// Retorno da autenticação no app nativo. O navegador externo (Google, link de
// confirmação de e-mail) volta por app.verbete.game://auth/callback?code=...
// e o código PKCE é trocado pela sessão AQUI — uma vez por código: o mesmo
// link pode chegar pelo cold start (getLaunchUrl) e pelo evento appUrlOpen,
// ou de novo numa recarga do WebView. Callback inválido ou com erro nunca
// derruba o app: vira mensagem na tela de login.
import { NATIVE_AUTH_CALLBACK } from "./auth-redirect";

export const AUTH_CALLBACK_EVENT = "verbete:auth-callback";
const HANDLED_KEY = "verbete:auth-codes-handled";
const ERROR_KEY = "verbete:auth-callback-error";
const handled = new Set<string>();

export type AuthCallbackResult = { ok: true } | { ok: false; error: string };

export function isAuthCallback(url: string): boolean {
  return url.startsWith(NATIVE_AUTH_CALLBACK);
}

export function parseAuthCallback(url: string): {
  code: string | null;
  error: string | null;
} {
  try {
    const u = new URL(url);
    const q = u.searchParams;
    const h = new URLSearchParams(u.hash.replace(/^#/, ""));
    const error =
      q.get("error_description") ??
      h.get("error_description") ??
      q.get("error") ??
      h.get("error");
    return { code: q.get("code"), error };
  } catch {
    return { code: null, error: "Retorno do login inválido." };
  }
}

function alreadyHandled(code: string): boolean {
  if (handled.has(code)) return true;
  try {
    const list = JSON.parse(sessionStorage.getItem(HANDLED_KEY) ?? "[]");
    return Array.isArray(list) && list.includes(code);
  } catch {
    return false;
  }
}

function markHandled(code: string) {
  handled.add(code);
  try {
    const list = JSON.parse(sessionStorage.getItem(HANDLED_KEY) ?? "[]");
    const next = (Array.isArray(list) ? list : []).slice(-9);
    next.push(code);
    sessionStorage.setItem(HANDLED_KEY, JSON.stringify(next));
  } catch {
    /* storage indisponível: fica só a proteção em memória */
  }
}

/** Erro de um retorno que chegou antes da tela de login montar (cold start). */
export function takePendingAuthError(): string | null {
  try {
    const msg = sessionStorage.getItem(ERROR_KEY);
    sessionStorage.removeItem(ERROR_KEY);
    return msg;
  } catch {
    return null;
  }
}

/**
 * Trata o link se for retorno de autenticação. Devolve null quando não é
 * (ou é repetição de um código já tratado) — aí o chamador segue o fluxo
 * normal dos App Links.
 */
export async function handleAuthCallback(
  url: string,
): Promise<AuthCallbackResult | null> {
  if (!isAuthCallback(url)) return null;
  const { code, error } = parseAuthCallback(url);
  // getLaunchUrl devolve o MESMO link a cada recarga do WebView: cada retorno
  // (pelo código; sem código, pelo link inteiro) é tratado uma única vez.
  const key = code ?? url;
  if (alreadyHandled(key)) return null;
  markHandled(key);
  let result: AuthCallbackResult;
  if (error) {
    result = { ok: false, error };
  } else if (!code) {
    result = { ok: false, error: "Retorno do login sem código." };
  } else {
    try {
      const { ensureAnonSession } = await import("./auth-session");
      const { supabase } = await import("@/integrations/supabase/client");
      // A sessão anônima do boot termina ANTES da troca — se terminasse
      // depois, sobrescreveria a sessão da conta recém-logada.
      await ensureAnonSession();
      const { error: exchangeError } =
        await supabase.auth.exchangeCodeForSession(code);
      result = exchangeError
        ? { ok: false, error: exchangeError.message }
        : { ok: true };
    } catch (e) {
      result = { ok: false, error: (e as Error).message };
    }
  }
  if (!result.ok) {
    try {
      sessionStorage.setItem(ERROR_KEY, result.error);
    } catch {
      /* sem storage: o evento abaixo ainda avisa a tela aberta */
    }
  }
  window.dispatchEvent(
    new CustomEvent<AuthCallbackResult>(AUTH_CALLBACK_EVENT, {
      detail: result,
    }),
  );
  const target = result.ok ? "/profile" : "/login";
  if (window.location.pathname !== target) window.location.href = target;
  return result;
}
