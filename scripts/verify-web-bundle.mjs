// Verificação POSITIVA do bundle web antes do deploy (incidente P1 de 05/11/2026).
// Não basta "não aparecer erro": exige que a URL e a chave pública ESPERADAS
// (wrangler.jsonc) estejam embutidas no cliente, que o build ID seja o pedido e
// que nenhum segredo administrativo tenha vazado para o cliente.
// Nunca imprime valores — só contagens e o nome do que falhou.
//
// Uso: node scripts/verify-web-bundle.mjs [dist] [--build-id <sha>]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readWranglerPublicVars } from "../build/wrangler-public-vars.mjs";

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(m?js|html|css|json)$/.test(name)) out.push(p);
  }
  return out;
}

/** Mesmo valor de LEGAL_PENDING_MARK (src/lib/legal.ts; um teste amarra). */
export const LEGAL_PENDING_MARK = "<PENDENTE";

const countFiles =(texts, needle) => texts.filter((t) => t.includes(needle)).length;

function jwtRole(token) {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")).role ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {{ distDir: string, expectedUrl?: string, expectedKey?: string, buildId?: string }} o
 * @returns {{ ok: boolean, problems: string[], facts: Record<string, number> }}
 */
export function verifyWebBundle({ distDir, expectedUrl, expectedKey, buildId }) {
  const problems = [];
  const clientDir = join(distDir, "client");
  let texts = [];
  try {
    texts = files(clientDir).map((f) => readFileSync(f, "utf8"));
  } catch {
    return { ok: false, problems: [`pasta do cliente ausente: ${clientDir}`], facts: {} };
  }
  if (texts.length === 0) problems.push("cliente sem arquivos JS/HTML");

  const facts = {
    arquivos: texts.length,
    url: expectedUrl ? countFiles(texts, expectedUrl) : 0,
    chave: expectedKey ? countFiles(texts, expectedKey) : 0,
    buildId: buildId ? countFiles(texts, buildId) : 0,
  };
  if (!expectedUrl) problems.push("URL pública esperada não informada");
  else if (facts.url === 0) problems.push("VITE_SUPABASE_URL esperada NÃO está embutida no cliente");
  if (!expectedKey) problems.push("chave pública esperada não informada");
  else if (facts.chave === 0) problems.push("VITE_SUPABASE_PUBLISHABLE_KEY esperada NÃO está embutida no cliente");
  if (buildId && facts.buildId === 0) problems.push("build ID pedido NÃO está no cliente");

  // segredos administrativos jamais no cliente
  const all = texts.join("\n");
  facts.sbSecret = (all.match(/sb_secret_[A-Za-z0-9_-]{10,}/g) ?? []).length;
  facts.tokenPessoal = (all.match(/sbp_[A-Za-z0-9]{20,}/g) ?? []).length;
  facts.serviceRole = (all.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g) ?? []).filter(
    (t) => jwtRole(t) === "service_role",
  ).length;
  facts.chaveGoogle = (all.match(/AIza[0-9A-Za-z_-]{35}/g) ?? []).length;
  if (facts.sbSecret) problems.push("chave secreta do Supabase (sb_secret_) no cliente");
  if (facts.tokenPessoal) problems.push("token pessoal do Supabase (sbp_) no cliente");
  if (facts.serviceRole) problems.push("JWT service_role no cliente");
  if (facts.chaveGoogle) problems.push("chave de API do Google no cliente");

  // Textos legais pendentes (modo sem IA externa, src/lib/legal.ts): o
  // marcador "<PENDENTE" (nome legal do desenvolvedor, data dos Termos) nunca
  // pode chegar ao bundle — nem no cliente nem no SSR. Com a IA ligada o
  // ramo sem IA é eliminado no build e o marcador não aparece.
  let serverTexts = [];
  try {
    serverTexts = files(join(distDir, "server")).map((f) => readFileSync(f, "utf8"));
  } catch {
    /* build sem SSR (ex.: shell nativo): só o cliente */
  }
  facts.pendenteLegal = [...texts, ...serverTexts].filter((t) => t.includes(LEGAL_PENDING_MARK)).length;
  if (facts.pendenteLegal)
    problems.push("texto legal PENDENTE no bundle (DEVELOPER_LEGAL_NAME/NO_AI_TERMS_VERSION em src/lib/legal.ts)");

  return { ok: problems.length === 0, problems, facts };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const i = args.indexOf("--build-id");
  const buildId = i >= 0 ? args[i + 1] : process.env.VITE_BUILD_ID;
  const distDir = resolve(args.find((a, k) => !a.startsWith("--") && args[k - 1] !== "--build-id") ?? join(root, "dist"));
  const vars = readWranglerPublicVars(join(root, "wrangler.jsonc"));
  const r = verifyWebBundle({
    distDir,
    expectedUrl: vars.SUPABASE_URL,
    expectedKey: vars.SUPABASE_PUBLISHABLE_KEY,
    buildId,
  });
  console.log(`[verify-web-bundle] ${JSON.stringify(r.facts)}`);
  if (!r.ok) {
    console.error(`[verify-web-bundle] REPROVADO:\n  • ${r.problems.join("\n  • ")}`);
    process.exit(1);
  }
  console.log("[verify-web-bundle] OK — configuração pública presente, sem segredos no cliente");
}
