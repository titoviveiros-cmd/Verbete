// Registro do aceite dos Termos no aparelho, POR IDENTIDADE (P1-A do PR #26):
// { ids: { <resumo do UID>: { version, at } } }. Só a versão aceita e a data —
// nenhum token, senha ou segredo, e nem o UID em si (só um resumo dele).
// Puro (sem React/Supabase): o playwright.config monta o aparelho de teste.
//
import { AI_TERMS_VERSION, NO_AI_LEGAL } from "./legal";

// TERMS_VERSION = data da "Última atualização" de /terms (um teste amarra
// as duas): revisão material dos Termos → data nova → novo aceite.
// 2026-10-27: conteúdo proibido completo, denúncia de jogador, moderação,
// IA e licença (rodada 2A da conformidade Google Play). Anterior: 2026-05-18.
// Modo sem IA externa (legal.ts, NO_AI_LEGAL): a versão passa a ser a data
// dos Termos sem IA e com o nome do desenvolvedor — UM novo aceite, só quando
// EXTERNAL_AI_MODE = "desligada". Com a IA ligada, nada muda.
export const TERMS_VERSION = NO_AI_LEGAL?.termsVersion ?? AI_TERMS_VERSION;
export const TERMS_STORAGE_KEY = "verbete:terms-accepted";
/** Identidades lembradas por aparelho (cada logout abre uma anônima nova). */
const MAX_IDENTITIES = 20;

export type TermsEntry = { version: string; at: string };
export type TermsRecord = {
  ids: Record<string, TermsEntry>;
  /** Formato do 1º PR #26, sem identidade: {version, at} do aparelho. */
  legacy: TermsEntry | null;
};

const EMPTY: TermsRecord = { ids: {}, legacy: null };

/** Resumo de 53 bits do UID (cyrb53): casa a identidade sem guardá-la. */
export function identityKey(uid: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < uid.length; i++) {
    const ch = uid.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function isEntry(v: unknown): v is TermsEntry {
  const e = v as Partial<TermsEntry> | null;
  return typeof e?.version === "string" && typeof e.at === "string";
}

/** Lixo, registro forjado pela metade ou ausente → nenhum aceite. */
export function parseTermsRecord(raw: string | null): TermsRecord {
  if (!raw) return EMPTY;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  const ids = (data as { ids?: unknown } | null)?.ids;
  if (ids && typeof ids === "object") {
    const ok = Object.entries(ids).filter(([, e]) => isEntry(e));
    return { ids: Object.fromEntries(ok) as TermsRecord["ids"], legacy: null };
  }
  return isEntry(data) ? { ids: {}, legacy: data } : EMPTY;
}

/** O formato antigo nunca é regravado. */
export function serializeTermsRecord(rec: TermsRecord): string {
  return JSON.stringify({ ids: rec.ids });
}

export function acceptedBy(rec: TermsRecord, uid: string): boolean {
  return rec.ids[identityKey(uid)]?.version === TERMS_VERSION;
}

export function withAcceptance(
  rec: TermsRecord,
  uid: string,
  entry: TermsEntry,
): TermsRecord {
  const all = Object.entries({ ...rec.ids, [identityKey(uid)]: entry });
  const kept = all
    .sort(([, a], [, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_IDENTITIES);
  return { ids: Object.fromEntries(kept), legacy: null };
}
