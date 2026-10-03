import type { FullConfig } from "@playwright/test";

// A suíte só roda contra o Verbete. Em 01/10 um dev server órfão de outro
// projeto ocupava a porta 5173 e, com reuseExistingServer, os testes
// "falharam" exercitando o jogo errado (achado TI-01 da auditoria).
export default async function globalSetup(config: FullConfig) {
  // Alvo explícito (smoke pós-deploy): o operador já escolheu o servidor.
  if (process.env.E2E_BASE_URL) return;
  const baseURL = config.projects[0]?.use.baseURL ?? "http://localhost:5173";
  const html = await (await fetch(baseURL)).text();
  if (!/<meta[^>]+name="verbete-build"/.test(html)) {
    throw new Error(
      `O servidor em ${baseURL} não é o Verbete (sem a meta verbete-build). ` +
        "Porta ocupada por outro app? Encerre-o e rode de novo.",
    );
  }
}
