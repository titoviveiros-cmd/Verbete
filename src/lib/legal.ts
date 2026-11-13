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

// ---------------------------------------------------------------------------
// Data exibida × versão de CONSENTIMENTO (11/11/2026).
// Cada revisão dos Termos entra em TERMS_CHANGES. A data exibida em /terms é a
// da ÚLTIMA revisão; a versão aceita (TERMS_VERSION em terms-record.ts) é a da
// última revisão MATERIAL. Só revisão material pede novo aceite.
// MATERIAL = cria ou amplia tratamento/compartilhamento de dados ou a licença
// sobre o conteúdo; cria/muda obrigação, restrição, sanção ou direito do
// usuário (denúncia, recurso, banimento); muda a parte contratante. NÃO
// material = redação, erro de digitação, link, contato, data, reordenação, ou
// retirar um tratamento sem criar outro. Na dúvida: material.
// ---------------------------------------------------------------------------

export type TermsChange = {
  /** AAAA-MM-DD — vira a "Última atualização" de /terms. */
  date: string;
  /** true = pede novo aceite (versão de consentimento passa a ser esta data). */
  material: boolean;
  resumo: string;
};

/** Histórico publicado dos Termos com a IA ligada. */
export const AI_TERMS_CHANGES: readonly TermsChange[] = [
  { date: "2026-05-18", material: true, resumo: "primeira versão" },
  {
    date: AI_TERMS_VERSION,
    material: true,
    resumo:
      "conteúdo proibido completo, denúncia de jogador, moderação, IA e licença",
  },
];

/**
 * Pacote ÚNICO de reaceite do modo sem IA: textos sem IA externa (#63), nome
 * legal do desenvolvedor (parte contratante) e o fluxo de denúncia com
 * retorno, aviso ao autor e recurso da página /denuncias (#65, ECA Digital
 * arts. 28–30). Material (muda a parte contratante e os direitos de denúncia
 * e recurso) → UM novo aceite, na data da ativação. A ativação exige
 * /denuncias no repositório (build/legal-guard.ts): sem ela, os dois textos
 * pediriam dois aceites.
 */
export const NO_AI_TERMS_CHANGE: TermsChange = {
  date: NO_AI_TERMS_VERSION,
  material: true,
  resumo:
    "sem IA externa, nome legal do desenvolvedor e denúncia com retorno, aviso ao autor e recurso (/denuncias)",
};

/** Data exibida e versão de consentimento de um histórico (puro, testado). */
export function termsVersionsOf(changes: readonly TermsChange[]): {
  display: string;
  consent: string;
} {
  if (changes.length === 0) throw new Error("TERMS_CHANGES vazio");
  const display = changes[changes.length - 1]!.date;
  const material = changes.filter((c) => c.material);
  if (material.length === 0) throw new Error("nenhuma revisão material");
  return { display, consent: material[material.length - 1]!.date };
}

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

/** Histórico vigente: com a IA ligada, exatamente o publicado. */
export const TERMS_CHANGES: readonly TermsChange[] = NO_AI_LEGAL
  ? [...AI_TERMS_CHANGES, NO_AI_TERMS_CHANGE]
  : AI_TERMS_CHANGES;

const TERMS_VERSIONS = termsVersionsOf(TERMS_CHANGES);
/** "Última atualização" de /terms. */
export const TERMS_DISPLAY_DATE = TERMS_VERSIONS.display;
/** Versão aceita (= TERMS_VERSION em terms-record.ts). */
export const TERMS_CONSENT_VERSION = TERMS_VERSIONS.consent;

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
  if (!isPlausibleLegalName(values.developerName))
    out.push("DEVELOPER_LEGAL_NAME");
  // Data válida, DIFERENTE e POSTERIOR à dos Termos com IA: texto novo sem
  // versão nova = mudança sem novo aceite.
  if (
    !isIsoDate(values.termsVersion) ||
    values.termsVersion <= AI_TERMS_VERSION
  )
    out.push("NO_AI_TERMS_VERSION");
  return out;
}

/**
 * Nome legal plausível: ≥ 3 caracteres com letra, sem "<"/">" e sem sobra de
 * marcador ("PENDENTE", "confirmar", "TODO", sem diferenciar maiúsculas).
 * Apagar só o "<" do marcador NÃO passa.
 */
export function isPlausibleLegalName(raw: string): boolean {
  const name = raw.trim();
  if (name.length < 3 || !/\p{L}/u.test(name)) return false;
  if (/[<>]/.test(name)) return false;
  return !/pendente|confirmar|\btodo\b/i.test(name);
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
