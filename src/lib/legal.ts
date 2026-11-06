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
