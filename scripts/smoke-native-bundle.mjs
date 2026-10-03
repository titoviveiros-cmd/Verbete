// Smoke do bundle nativo (dist/client depois de `vite build --mode capacitor`):
// prova que o app instalado inicializa o client do Supabase com configuração
// pública válida — e que nada secreto ou de desenvolvimento entrou nele.
// Uso: node scripts/smoke-native-bundle.mjs [dir]   (EXPECT_BUILD_ID opcional)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(process.argv[2] ?? "dist/client");
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|html|json|webmanifest)$/.test(f)) files.push(p);
  }
})(DIR);
const blob = files.map((f) => readFileSync(f, "utf8")).join("\n");

let fails = 0;
const check = (name, ok) => {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) fails++;
};

const jwtRole = (t) => {
  try {
    const p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(p, "base64").toString("utf8")).role ?? null;
  } catch {
    return null;
  }
};

check(
  "index.html do shell SPA presente",
  files.some((f) => /[\\/]index\.html$/.test(f)),
);

const supaUrl = blob.match(/https:\/\/[a-z0-9]{20}\.supabase\.co/)?.[0];
check(`URL do Supabase embutida (${supaUrl ?? "nenhuma"})`, !!supaUrl);
if (process.env.EXPECT_SUPABASE_URL) {
  check(
    "URL do Supabase é a esperada",
    supaUrl === process.env.EXPECT_SUPABASE_URL,
  );
}

const pubKey = blob.match(/sb_publishable_[A-Za-z0-9_-]{10,}/)?.[0];
const jwts =
  blob.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g) ??
  [];
const roles = jwts.map(jwtRole);
check(
  `chave PÚBLICA embutida (${pubKey ? pubKey.slice(0, 18) + "…" : roles.includes("anon") ? "JWT anon" : "nenhuma"})`,
  !!pubKey || roles.includes("anon"),
);
// A biblioteca supabase-js contém o PREFIXO literal ("sb_secret_") para
// recusar chave secreta no browser; uma chave real tem o corpo em seguida.
check(
  "nenhuma chave secreta (sb_secret_…)",
  !/sb_secret_[A-Za-z0-9_-]{8,}/.test(blob),
);
check("nenhum JWT service_role", !roles.includes("service_role"));

check(
  "APP_URL pública embutida (links de convite)",
  blob.includes("https://jogo.verbete.workers.dev"),
);
check(
  "sem o domínio inexistente https://verbete.app",
  !/https:\/\/verbete\.app(?![\w.-])/.test(blob),
);
check("sem URL de servidor de desenvolvimento", !/localhost:5173/.test(blob));

const build = process.env.EXPECT_BUILD_ID;
if (build)
  check(
    `build id ${build.slice(0, 7)} embutido (rodapé sem "v dev")`,
    blob.includes(build),
  );

console.log(
  fails
    ? `\n${fails} FALHA(S) — bundle nativo NÃO publicável`
    : `\nBUNDLE NATIVO OK (${files.length} arquivos)`,
);
process.exit(fails ? 1 : 0);
