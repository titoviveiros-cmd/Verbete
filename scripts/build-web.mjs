// Build web de PRODUÇÃO num comando só (o ritual que faltou no incidente P1 de
// 05/11/2026): configuração pública do Supabase vinda de wrangler.jsonc (a
// mesma do SSR), build ID = commit atual, e verificação positiva do bundle no
// fim. Nunca imprime os valores.
//
// Uso: npm run build:web
//   Env opcionais: VITE_BUILD_ID (padrão: git HEAD), VITE_APP_URL (padrão: URL
//   canônica). VITE_SUPABASE_URL/PUBLISHABLE_KEY, se vierem, têm de ser IGUAIS
//   às de wrangler.jsonc (senão o cliente falaria com outro banco que o SSR).
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerPublicVars } from "../build/wrangler-public-vars.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vars = readWranglerPublicVars(join(root, "wrangler.jsonc"));
const fail = (m) => {
  console.error(`[build-web] ${m}`);
  process.exit(1);
};
if (!vars.SUPABASE_URL || !vars.SUPABASE_PUBLISHABLE_KEY)
  fail("wrangler.jsonc sem vars.SUPABASE_URL / vars.SUPABASE_PUBLISHABLE_KEY");

const env = { ...process.env };
for (const [viteKey, value] of [
  ["VITE_SUPABASE_URL", vars.SUPABASE_URL],
  ["VITE_SUPABASE_PUBLISHABLE_KEY", vars.SUPABASE_PUBLISHABLE_KEY],
]) {
  const given = env[viteKey]?.trim();
  if (given && given !== value) fail(`${viteKey} do ambiente difere de wrangler.jsonc — build abortado`);
  env[viteKey] = value;
}
env.NODE_ENV = "production"; // inclui o plugin do Cloudflare (bundle do Worker)
if (!env.VITE_BUILD_ID) {
  try {
    env.VITE_BUILD_ID = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    fail("sem VITE_BUILD_ID e sem git para descobrir o commit");
  }
}
env.VITE_APP_URL ||= "https://jogo.verbete.workers.dev";

console.log(`[build-web] build ${env.VITE_BUILD_ID.slice(0, 7)} com a configuração pública de wrangler.jsonc`);
const run = (cmd, args) =>
  spawnSync(cmd, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
const b = run("npx", ["vite", "build"]);
if (b.status !== 0) fail(`vite build falhou (exit ${b.status})`);
const v = run("node", ["scripts/verify-web-bundle.mjs", "dist", "--build-id", env.VITE_BUILD_ID]);
if (v.status !== 0) fail("verificação do bundle REPROVOU — não publique este dist");
console.log("[build-web] OK");
