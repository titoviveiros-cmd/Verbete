// Typecheck das edge functions (Deno). Elas ficam fora do tsc do projeto: foi
// assim que um identificador inexistente (`norm`) derrubou a IA dos bots de
// 27/07 a 02/10 sem nenhum sinal. Roda no CI do PR pelo executor de suítes
// (o passo equivalente no ci.yml depende do commit de workflows).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

const fns = readdirSync("supabase/functions", { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(`supabase/functions/${d.name}/index.ts`))
  .map((d) => `supabase/functions/${d.name}/index.ts`);
const r = spawnSync("npx", ["--yes", "deno@2", "check", ...fns], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
console.log(
  r.status === 0
    ? `\nDENO CHECK OK — ${fns.length} edge functions: ${fns.map((f) => f.split("/")[2]).join(", ")}`
    : "\nDENO CHECK FALHOU",
);
process.exit(r.status === 0 ? 0 : 1);
