// Trava do modo "sem IA externa" (13+, 10/11/2026; docs/sem-ia-externa.md).
// Com EXTERNAL_AI_MODE = "desligada", /privacy e /terms citam o nome legal do
// desenvolvedor e os Termos ganham a versão nova. Se o nome ou a data ainda
// forem o marcador "<PENDENTE…>", o build de PRODUÇÃO (web e nativo) FALHA
// aqui, antes de gerar qualquer arquivo. Com a IA ligada nada é exigido.
// Terceira camada: scripts/verify-web-bundle.mjs reprova o dist se o marcador
// chegar ao bundle.
import { pendingNoAiLegal } from "../src/lib/legal";

export function noAiLegalProblems(pending = pendingNoAiLegal()): string[] {
  return pending.map(
    (name) =>
      `${name} pendente em src/lib/legal.ts (modo sem IA externa ligado)`,
  );
}

export function assertNoAiLegalReady(pending = pendingNoAiLegal()): void {
  const problems = noAiLegalProblems(pending);
  if (problems.length > 0) {
    throw new Error(
      "Build de produção bloqueado — textos legais sem IA incompletos:\n  • " +
        problems.join("\n  • "),
    );
  }
}
