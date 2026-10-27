// Aceite dos Termos antes de criar conteúdo (Google Play, política de UGC:
// "Require users accept the app's terms of use … before users can create
// or upload UGC"). Conteúdo de usuário no Verbete: apelido e definições
// (vistos pela sala), o nome da conta (visto no ranking) e o palpite do
// Desafio Diário (que põe o nome no ranking do dia).
//
// O aceite é da IDENTIDADE da sessão Supabase em vigor, não do aparelho:
// convidado = a sessão anônima dele; conta = o UID dela. A não empresta o
// aceite a B no mesmo aparelho, e o logout (sessão anônima nova) pede de novo.
// Navegar não é aceite — só a caixa marcada no momento de criar conteúdo.
//
// Duas camadas: a caixa (useTermsGate) segue a identidade ao vivo, e a trava
// das funções que gravam (assertTermsAccepted) relê o UID da sessão no
// instante da gravação — troca de conta entre a tela e o clique não passa.
// É uma garantia do APP: as RPCs e a server function do Diário não conferem
// aceite no servidor (sem registro central), então chamadas diretas à API,
// fora do app, continuam possíveis.
import { useSyncExternalStore } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  SESSION_REQUIRED_MESSAGE,
  onSessionPendingChange,
  sessionPending,
} from "./auth-session";
import {
  TERMS_STORAGE_KEY as KEY,
  TERMS_VERSION,
  acceptedBy,
  parseTermsRecord,
  serializeTermsRecord,
  withAcceptance,
  type TermsEntry,
  type TermsRecord,
} from "./terms-record";

export { TERMS_VERSION } from "./terms-record";

// undefined = identidade carregando (sessão sendo lida/renovada no boot);
// null = sem sessão (carregando também enquanto uma é aberta); string = UID
// da sessão em vigor.
let uid: string | null | undefined;
let tracking = false;
// Só quando o storage FALHA (aba privada bloqueada, cota): aceites em
// memória, por identidade, até fechar a aba.
let memory: TermsRecord["ids"] = {};
// Caixa marcada antes de existir sessão (aparelho novo sem rede no boot): a
// gravação seguinte desta aba prende o aceite ao UID que ela usar.
let pending: TermsEntry | null = null;
let legacySettled = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function readRecord(): TermsRecord {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { ids: { ...memory }, legacy: null };
  }
  const rec = parseTermsRecord(raw);
  return {
    ids: { ...rec.ids, ...memory },
    legacy: legacySettled ? null : rec.legacy,
  };
}

function writeRecord(rec: TermsRecord): void {
  try {
    localStorage.setItem(KEY, serializeTermsRecord(rec));
    memory = {};
  } catch {
    memory = rec.ids; // sem storage: o aceite fica em memória
  }
}

// O 1º PR #26 (nunca publicado: só existe em aparelhos de teste) gravava só
// {version, at}, sem identidade. Migração conservadora, uma vez: vira o
// aceite da sessão ANÔNIMA em vigor (o convidado daquele aparelho); conta
// autenticada não herda nada. Depois, o formato antigo deixa de existir.
function settleLegacy(session: Session): void {
  if (legacySettled) return;
  const rec = readRecord();
  legacySettled = true;
  if (!rec.legacy) return;
  const anonymous = session.user.is_anonymous === true;
  writeRecord(
    anonymous && rec.legacy.version === TERMS_VERSION
      ? withAcceptance(rec, session.user.id, rec.legacy)
      : rec,
  );
}

function setIdentity(session: Session | null): void {
  const next = session?.user?.id ?? null;
  if (session && next) settleLegacy(session);
  if (next === uid) return;
  // A marcação de A não passa para B (nem para o logout de A); a feita sem
  // sessão só vale para a anônima que o app abrir — login em conta a descarta.
  if (typeof uid === "string" || (next && session?.user?.is_anonymous !== true))
    pending = null;
  uid = next;
  notify();
}

function track(): void {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  onSessionPendingChange(notify);
  try {
    // Emite INITIAL_SESSION a quem assina e toda troca depois (login,
    // logout, sessão anônima nova, outra aba).
    supabase.auth.onAuthStateChange((_event, session) => setIdentity(session));
  } catch {
    /* cliente sem auth (testes de unidade): a identidade segue "carregando" */
  }
}

function snapshot(): boolean | null {
  if (typeof window === "undefined" || uid === undefined) return null;
  // Sem sessão: se o app está abrindo uma agora (boot), a identidade ainda
  // vem; senão (logout), quem chegar é nova e precisa aceitar.
  if (uid === null) return sessionPending() ? null : false;
  return acceptedBy(readRecord(), uid);
}

/** A identidade em vigor já aceitou esta versão (false se ainda carregando). */
export function hasAcceptedTerms(): boolean {
  track();
  return snapshot() === true;
}

/** Caixa marcada no envio: o aceite é da identidade em vigor. */
export function acceptTerms(): void {
  track();
  const entry = { version: TERMS_VERSION, at: new Date().toISOString() };
  if (typeof uid === "string") {
    writeRecord(withAcceptance(readRecord(), uid, entry));
    pending = null;
  } else {
    pending = entry; // sem sessão ainda: a gravação prende ao UID dela
  }
  notify();
}

/** Conta criada agora por esta aba (cadastro por e-mail): o aceite é dela. */
export function acceptTermsFor(accountId: string): void {
  const entry = { version: TERMS_VERSION, at: new Date().toISOString() };
  writeRecord(withAcceptance(readRecord(), accountId, entry));
  notify();
}

function subscribe(cb: () => void): () => void {
  track();
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

/** true/false no cliente; null no SSR e enquanto a identidade carrega. */
export function useTermsAccepted(): boolean | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** UID da sessão em vigor (undefined = carregando) — para notar a troca. */
export function useTermsIdentity(): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => uid,
    () => undefined,
  );
}

export class TermsRequiredError extends Error {
  constructor() {
    super("Para continuar, aceite os Termos de Uso.");
    this.name = "TermsRequiredError";
  }
}

/**
 * Trava das funções que gravam conteúdo, logo antes da gravação: relê o UID
 * da sessão em vigor (é com ele que a gravação sai) e exige o aceite DELE.
 */
export async function assertTermsAccepted(): Promise<void> {
  if (typeof window === "undefined") throw new TermsRequiredError();
  track();
  let session: Session | null = null;
  try {
    ({
      data: { session },
    } = await supabase.auth.getSession());
  } catch {
    session = null;
  }
  const id = session?.user?.id;
  if (!session || !id) throw new Error(SESSION_REQUIRED_MESSAGE);
  // A tela passa a seguir a sessão lida aqui (troca sem aviso de outra aba:
  // a caixa aparece para quem está). Marcação pendente de outra identidade,
  // ou de antes de um login em conta, já some nesta troca.
  setIdentity(session);
  if (pending) {
    // marcada sem sessão (aparelho novo): é o aceite de quem grava agora
    writeRecord(withAcceptance(readRecord(), id, pending));
    pending = null;
    notify();
  }
  if (!acceptedBy(readRecord(), id)) throw new TermsRequiredError();
}
