// Trava do build WEB (vite build sem --mode capacitor). Incidente P1 de
// 05/11/2026: o Worker foi publicado com um bundle SEM VITE_SUPABASE_URL e
// VITE_SUPABASE_PUBLISHABLE_KEY — o cliente lançava "Missing Supabase
// environment variable(s)" e a Home caía no "Ops! Algo deu errado" para todos.
// typecheck, testes e `wrangler deploy --dry-run` passaram: nada olhava a
// configuração pública embutida. Agora o build FALHA antes de gerar o bundle.
//
// Os valores são públicos (chave publishable, não segredo), mas nunca são
// impressos: as mensagens dizem só O QUE falta.
import { isPublicHttps, supabasePublicProblems } from "./native-env";

/** Problemas da configuração pública do bundle web (vazia = ok). */
export function webEnvProblems(
  env: Record<string, string | undefined>,
): string[] {
  const problems = supabasePublicProblems(env);
  // VITE_APP_URL é opcional no web (app-url.ts cai na URL canônica), mas se
  // vier, tem de ser https público.
  const appUrl = env.VITE_APP_URL?.trim();
  if (appUrl && !isPublicHttps(appUrl)) {
    problems.push("VITE_APP_URL informada mas não é https público");
  }
  return problems;
}

export function assertWebEnv(env: Record<string, string | undefined>): void {
  const problems = webEnvProblems(env);
  if (problems.length > 0) {
    throw new Error(
      "Build web bloqueado — configuração pública inválida:\n  • " +
        problems.join("\n  • ") +
        "\nUse `npm run build:web` (lê os valores públicos de wrangler.jsonc) " +
        "ou exporte VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY.",
    );
  }
}
