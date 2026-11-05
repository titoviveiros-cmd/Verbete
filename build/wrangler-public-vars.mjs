// Vars PÚBLICAS do Worker em wrangler.jsonc — a mesma configuração que o SSR
// usa em produção. Fonte única para o cliente web (scripts/build-web.mjs e
// scripts/verify-web-bundle.mjs). JS puro: roda no Node sem etapa de build.
import { readFileSync } from "node:fs";

/** Remove comentários (// e /* *\/) fora de strings e vírgulas finais. */
export function parseJsonc(raw) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += raw[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function readWranglerPublicVars(path) {
  const json = parseJsonc(readFileSync(path, "utf8"));
  const v = (json && json.vars) || {};
  const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  return {
    SUPABASE_URL: str(v.SUPABASE_URL),
    SUPABASE_PUBLISHABLE_KEY: str(v.SUPABASE_PUBLISHABLE_KEY),
  };
}
