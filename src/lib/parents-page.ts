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
 * Nome legal do desenvolvedor (responsável pelo jogo e pelos dados). Decisão
 * do dono (16/11/2026): titular da conta pessoal do Play Console + nome
 * público. MESMO texto de DEVELOPER_LEGAL_NAME (src/lib/legal.ts, PR #63): um
 * teste reprova se, na árvore integrada, os dois forem diferentes.
 */
export const PARENTS_DEVELOPER_NAME =
  "Tito Augusto Ramos de Viveiros (nome público: Tito Viveiros)";
