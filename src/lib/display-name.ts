// Nome exibido de uma conta nova (Rodada 2B, 2026-10-27): só o que a pessoa
// digitou. Nunca a parte do e-mail antes do @ — o nome aparece no ranking e
// é legível por qualquer sessão. Sem nome (ou com um nome que repete o
// e-mail), o cadastro não manda nada e o banco usa DEFAULT_DISPLAY_NAME.
// Mesma regra no servidor: handle_new_user (20261027200100), que também
// protege contra o cliente antigo, que mandava o trecho do e-mail.
export const DEFAULT_DISPLAY_NAME = "Jogador";
export const DISPLAY_NAME_MAX = 24;

export function signupDisplayName(
  input: string,
  email: string,
): string | undefined {
  const name = input.trim().slice(0, DISPLAY_NAME_MAX).trim();
  if (!name || name.includes("@")) return undefined;
  const mail = email.trim().toLowerCase();
  const lower = name.toLowerCase();
  if (mail && (lower === mail || lower === mail.split("@")[0]))
    return undefined;
  return name;
}
