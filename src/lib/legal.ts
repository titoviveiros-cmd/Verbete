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

/** Identificador do app Android na Play (capacitor.config.ts → appId). */
export const ANDROID_PACKAGE = "app.verbete.game";
