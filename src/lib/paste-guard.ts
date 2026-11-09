// Anti-trapaça: colar e arrastar em campos de texto ficam bloqueados no app inteiro.
// Exceção ÚNICA: o campo do manifesto D1 no painel admin. Ela só vale quando as duas
// condições se cumprem: o elemento é marcado com data-allow-paste="admin-manifest" e a rota
// é /admin/…. Uma marca esquecida numa tela de partida não libera nada, e arrastar continua
// bloqueado em todo lugar. A permissão de admin é conferida no servidor
// (assertAdmin): isto aqui é conforto de interface, não segurança.
export const ADMIN_PASTE_MARK = "admin-manifest";

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/** true = o evento deve ser cancelado. */
export function shouldBlockEditEvent(
  type: string,
  target: EventTarget | null,
  pathname: string,
): boolean {
  if (!(target instanceof Element)) return false;
  const el = target as HTMLElement;
  const editable =
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable === true;
  if (!editable) return false;
  if (
    type === "paste" &&
    isAdminPath(pathname) &&
    el.getAttribute("data-allow-paste") === ADMIN_PASTE_MARK
  )
    return false;
  return true;
}
