// Aceite dos Termos antes de criar conteúdo (Google Play, política de UGC:
// "Require users accept the app's terms of use … before users can create
// or upload UGC"). Conteúdo de usuário no Verbete: apelido e definições
// (vistos pela sala) e o nome da conta (visto no ranking).
//
// Persistência no aparelho (convidado e logado): a versão aceita e a data.
// Navegar não é aceite — só a caixa marcada no momento de criar conteúdo.
// TERMS_VERSION = data da "Última atualização" de /terms (um teste amarra
// as duas): revisão material dos Termos → data nova → novo aceite.
import { useSyncExternalStore } from "react";

export const TERMS_VERSION = "2026-05-18";
const KEY = "verbete:terms-accepted";

// Só quando o storage FALHA (aba privada bloqueada, cota): o aceite vale até
// fechar a aba. Com storage funcionando, vale só o que está gravado nele.
let memoryVersion: string | null = null;
const listeners = new Set<() => void>();

function storedVersion(): string | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return memoryVersion;
  }
  if (!raw) return memoryVersion;
  try {
    const v = (JSON.parse(raw) as { version?: unknown } | null)?.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function hasAcceptedTerms(): boolean {
  if (typeof window === "undefined") return false;
  return storedVersion() === TERMS_VERSION;
}

export function acceptTerms(): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: TERMS_VERSION, at: new Date().toISOString() }),
    );
    memoryVersion = null;
  } catch {
    memoryVersion = TERMS_VERSION; // sem storage: o aceite fica em memória
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** true/false no cliente; null no SSR (ainda não dá para saber). */
export function useTermsAccepted(): boolean | null {
  return useSyncExternalStore(subscribe, hasAcceptedTerms, () => null);
}

export class TermsRequiredError extends Error {
  constructor() {
    super("Para continuar, aceite os Termos de Uso.");
    this.name = "TermsRequiredError";
  }
}

/** Trava das funções que criam conteúdo: nenhum caminho pula o aceite. */
export function assertTermsAccepted(): void {
  if (!hasAcceptedTerms()) throw new TermsRequiredError();
}
