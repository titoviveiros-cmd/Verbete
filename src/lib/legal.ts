// Contato oficial do Verbete (decisão do proprietário, 26/10/2026): vale para
// privacidade, termos, suporte, pedido externo de exclusão de conta e teste
// do app. Os antigos endereços do domínio do jogo nunca receberam mensagens
// (domínio sem MX) — toda página pública usa ESTA constante; um teste barra
// e-mail escrito à mão nas rotas.
export const CONTACT_EMAIL = "titoviveiros@hotmail.com";

/** `mailto:` do contato oficial com assunto (e corpo) já preenchidos. */
export function contactMailto(subject: string, body?: string): string {
  const query = [`subject=${encodeURIComponent(subject)}`];
  if (body) query.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${CONTACT_EMAIL}?${query.join("&")}`;
}

/** Página pública de exclusão de conta (URL do campo do Google Play). */
export const DELETE_ACCOUNT_PATH = "/delete-account";

export type AiProvider = {
  /** Nome completo exibido nas páginas ("Google Gemini"). */
  name: string;
  /** Nome curto usado no meio das frases ("enviados ao Gemini"). */
  shortName: string;
  /** Rótulo e URL dos termos do serviço de IA. */
  termsLabel: string;
  termsUrl: string;
  /** Rótulo e URL da política de privacidade do provedor. */
  privacyLabel: string;
  privacyUrl: string;
  /**
   * Uso do conteúdo pelo PRÓPRIO provedor (fins dele), exibido na /privacy.
   * `null` = o provedor só presta o serviço ao Verbete. Não-nulo = no Data
   * Safety o "Outro conteúdo gerado pelo usuário" é COMPARTILHADO.
   */
  ownUseNotice: string | null;
};

/**
 * PONTO ÚNICO do provedor de IA nas páginas públicas (/privacy, /terms,
 * /support). Trocar o provedor (ex.: Cloudflare Workers AI) ou o plano =
 * editar SÓ este objeto + o teste "provedor de IA — ponto único"
 * (legal-pages.test.ts), que também amarra o objeto ao código das Edges e
 * do Worker e à versão dos Termos. Como /terms cita o provedor, a troca
 * muda o texto aceito: mudar também a data de /terms (TERMS_VERSION,
 * novo aceite).
 *
 * Hoje: Google Gemini no plano gratuito. Termos adicionais da Gemini API
 * (vigência 23/03/2026; a URL redireciona para aistudio.google.com/docs/terms):
 * no plano gratuito o Google usa o conteúdo enviado e as respostas para
 * fornecer, melhorar e desenvolver os produtos dele, com revisão humana.
 */
export const AI_PROVIDER: AiProvider = {
  name: "Google Gemini",
  shortName: "Gemini",
  termsLabel: "termos da API Gemini",
  termsUrl: "https://ai.google.dev/gemini-api/terms",
  privacyLabel: "Política de Privacidade do Google",
  privacyUrl: "https://policies.google.com/privacy",
  ownUseNotice:
    "Hoje o jogo usa o plano gratuito da API Gemini. Nesse plano, pelos termos do Google, o Google pode usar o conteúdo que enviamos — a palavra, as definições e os palpites — e as respostas da IA para fornecer, melhorar e desenvolver os produtos e serviços dele, e revisores humanos podem ler esse conteúdo.",
};

/** Identificador do app Android na Play (capacitor.config.ts → appId). */
export const ANDROID_PACKAGE = "app.verbete.game";

// ---------------------------------------------------------------------------
// Modo "sem IA externa" (13+, 10/11/2026) — docs/sem-ia-externa.md.
// O interruptor é EXTERNAL_AI_MODE (supabase/functions/_shared/external-ai.ts),
// uma constante de código: hoje "ligada" = páginas exatamente como antes.
// Com "desligada", as páginas trocam a IA por "o jogo não usa serviços
// externos de inteligência artificial", passam a citar o nome legal do
// desenvolvedor e os Termos ganham a versão NO_AI_TERMS_VERSION (UM novo
// aceite, nome + sem IA juntos).
// ---------------------------------------------------------------------------

import {
  EXTERNAL_AI_MODE,
  type ExternalAiMode,
} from "../../supabase/functions/_shared/external-ai.ts";

export {
  EXTERNAL_AI_MODE,
  isExternalAiOff,
  type ExternalAiMode,
} from "../../supabase/functions/_shared/external-ai.ts";

/** Marca de pendência: nunca pode chegar a um build de produção sem IA. */
export const LEGAL_PENDING_MARK = "<PENDENTE";

/**
 * Nome legal do desenvolvedor (controlador dos dados), IGUAL ao da conta do
 * Play Console. PENDENTE: confirmar com o dono. Só aparece nas páginas do
 * modo sem IA; com o modo "desligada" e este valor pendente, o build de
 * produção FALHA (build/legal-guard.ts, verify-web-bundle e
 * legal-sem-ia.test.ts).
 */
export const DEVELOPER_LEGAL_NAME = "<PENDENTE: confirmar com o dono>";

/**
 * Versão (= data "Última atualização", AAAA-MM-DD) dos Termos sem IA. É
 * preenchida no PR de ativação com a data da publicação. PENDENTE.
 */
export const NO_AI_TERMS_VERSION = "<PENDENTE: data da ativação AAAA-MM-DD>";

/** Versão dos Termos com a IA ligada (texto publicado em 27/10/2026). */
export const AI_TERMS_VERSION = "2026-10-27";

export type NoAiLegal = {
  /** Nome legal do desenvolvedor exibido em /privacy e /terms. */
  developerName: string;
  /** Versão/data dos Termos sem IA (TERMS_VERSION neste modo). */
  termsVersion: string;
};

/**
 * Pacote do modo sem IA, ou null com a IA ligada. As páginas usam SÓ isto:
 * com o modo "ligada" a comparação é constante e o bundle de produção nem
 * leva o nome pendente (verify-web-bundle confere).
 */
export const NO_AI_LEGAL: NoAiLegal | null =
  EXTERNAL_AI_MODE === "desligada"
    ? { developerName: DEVELOPER_LEGAL_NAME, termsVersion: NO_AI_TERMS_VERSION }
    : null;

/**
 * O que ainda falta para publicar o modo sem IA (vazio = pronto). Com a IA
 * ligada nada é exigido: o nome e a data só entram no modo sem IA.
 */
export function pendingNoAiLegal(
  mode: ExternalAiMode = EXTERNAL_AI_MODE,
  values: NoAiLegal = {
    developerName: DEVELOPER_LEGAL_NAME,
    termsVersion: NO_AI_TERMS_VERSION,
  },
): string[] {
  if (mode !== "desligada") return [];
  const out: string[] = [];
  const name = values.developerName.trim();
  if (name.length < 3 || name.includes(LEGAL_PENDING_MARK))
    out.push("DEVELOPER_LEGAL_NAME");
  if (!isIsoDate(values.termsVersion)) out.push("NO_AI_TERMS_VERSION");
  return out;
}

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** "2026-11-24" → "24 de novembro de 2026"; pendente → o próprio valor. */
export function formatLegalDate(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const [y, m, d] = iso.split("-");
  return `${Number(d)} de ${MESES[Number(m) - 1]} de ${y}`;
}
