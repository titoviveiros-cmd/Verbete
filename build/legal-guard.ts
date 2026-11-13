// Trava do modo "sem IA externa" (13+, 10/11/2026; docs/sem-ia-externa.md).
// Com EXTERNAL_AI_MODE = "desligada", /privacy e /terms citam o nome legal do
// desenvolvedor e os Termos ganham a versão nova. Se o nome ou a data ainda
// forem o marcador "<PENDENTE…>", o build de PRODUÇÃO (web e nativo) FALHA
// aqui, antes de gerar qualquer arquivo. Com a IA ligada nada é exigido.
// Terceira camada: scripts/verify-web-bundle.mjs reprova o dist se o marcador
// chegar ao bundle.
// 11/11/2026 — reaceite ÚNICO: os Termos sem IA (§4) já apontam para a página
// /denuncias (PR #65, ECA Digital arts. 28–30). Ativar o modo sem IA sem essa
// página = link quebrado e, depois, um SEGUNDO aceite quando o #65 chegar.
// Por isso o build sem IA também exige src/routes/denuncias.tsx.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isExternalAiOff, pendingNoAiLegal } from "../src/lib/legal";

export const DENUNCIAS_ROUTE_FILE = "src/routes/denuncias.tsx";

/** Pendências do pacote de reaceite único (vazio = pronto). */
export function pendingReaceiteUnico(
  off: boolean = isExternalAiOff(),
  exists: (rel: string) => boolean = (rel) =>
    existsSync(resolve(process.cwd(), rel)),
): string[] {
  if (!off) return [];
  return exists(DENUNCIAS_ROUTE_FILE) ? [] : ["DENUNCIAS_PAGE"];
}

export function noAiLegalProblems(
  pending = [...pendingNoAiLegal(), ...pendingReaceiteUnico()],
): string[] {
  return pending.map((name) =>
    name === "DENUNCIAS_PAGE"
      ? `${DENUNCIAS_ROUTE_FILE} ausente: o reaceite único dos Termos sem IA exige a página /denuncias (PR #65) no mesmo build`
      : `${name} pendente em src/lib/legal.ts (modo sem IA externa ligado)`,
  );
}

export function assertNoAiLegalReady(
  pending = [...pendingNoAiLegal(), ...pendingReaceiteUnico()],
): void {
  const problems = noAiLegalProblems(pending);
  if (problems.length > 0) {
    throw new Error(
      "Build de produção bloqueado — textos legais sem IA incompletos:\n  • " +
        problems.join("\n  • "),
    );
  }
}
