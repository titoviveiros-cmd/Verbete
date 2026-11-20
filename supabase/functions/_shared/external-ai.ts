// Modo "sem IA externa" (13+, 10/11/2026) — UMA constante de código, revisada
// em PR, que NÃO depende de app_config.ai_mode nem de variável de ambiente de
// produção. Usada pelas edges (Deno), pelo Worker (Diário) e pelas páginas
// (React): sem APIs do Deno nem do Node.
//
//   "ligada"    → comportamento de HOJE: provedor com texto legal publicado
//                 (AI_PROVIDERS_DISCLOSED = ["gemini"]), páginas legais com a
//                 seção de IA, Termos 2026-10-27. Nada muda em produção.
//   "desligada" → corte por CÓDIGO: AI_PROVIDERS_DISCLOSED = [] (qualquer
//                 perfil = configuração inválida = IA suspensa, com ou sem
//                 chave — falha FECHADA); páginas sem IA e com o nome legal do
//                 desenvolvedor; Termos com versão nova (UM novo aceite).
//
// Trocar para "desligada" é um PR de 3 linhas (este valor + DEVELOPER_LEGAL_NAME
// + NO_AI_TERMS_VERSION em src/lib/legal.ts) e SÓ na ordem do runbook
// (docs/sem-ia-externa.md): Diário em daily_mode='escolha' com estoque ≥ 168
// ANTES; com daily_mode='juiz' o Diário entra em pausa. O build de produção
// falha se o nome ou a data ainda estiverem pendentes (build/legal-guard.ts).

export type ExternalAiMode = "ligada" | "desligada";

export const EXTERNAL_AI_MODE: ExternalAiMode = "ligada";

/** true = operação sem IA externa (corte por código + textos sem IA). */
export function isExternalAiOff(
  mode: ExternalAiMode = EXTERNAL_AI_MODE,
): boolean {
  return mode === "desligada";
}
