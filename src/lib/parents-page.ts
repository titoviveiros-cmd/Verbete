// Página "Para pais e responsáveis" (/pais) — B7 do pacote ECA Digital
// (Lei 15.211/2025 art. 16; Lei 14.852/2024 art. 16 VI e VIII), 11/11/2026.
// Só o que EXISTE no código hoje: nada de modo parental, PIN, limite de tempo
// ou consentimento dos pais (não existem). Texto a validar com advogado(a)
// antes de publicar.

/** Caminho da página (rodapé da Home, Download e sitemap apontam para cá). */
export const PARENTS_PAGE_PATH = "/pais";

/** Página pública de denúncias do PR #65 (pode ainda não existir no build). */
export const REPORTS_PAGE_PATH = "/denuncias";

/**
 * Nome legal do desenvolvedor (responsável pelo jogo e pelos dados), IGUAL ao
 * da conta do Play Console. PENDENTE: confirmar com o dono.
 *
 * O marcador começa com "<PENDENTE" de propósito: é o LEGAL_PENDING_MARK do
 * PR #63, cuja verificação do bundle (scripts/verify-web-bundle.mjs) REPROVA
 * qualquer build de produção que leve esse texto. Ao integrar com o #63,
 * trocar esta constante por DEVELOPER_LEGAL_NAME de src/lib/legal.ts (fonte
 * única) — nunca apagar só o "<".
 */
export const PARENTS_DEVELOPER_NAME =
  "<PENDENTE: nome legal do desenvolvedor, igual ao da conta do Play Console>";
