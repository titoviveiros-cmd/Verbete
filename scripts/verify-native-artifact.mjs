// Auditoria do bundle web DENTRO do artefato Android (AAB ou APK), antes de
// qualquer envio à Play: a mesma verificação POSITIVA do bundle web
// (verify-web-bundle: URL/chave pública esperadas de wrangler.jsonc, build ID,
// nenhum segredo) aplicada a base/assets/public (AAB) ou assets/public (APK),
// mais o que só o nativo tem: canal do rodapé, versão = build.gradle e o
// retorno do login pelo esquema próprio.
// Nunca imprime valores secretos — só contagens, canal e versão (públicos).
//
// Uso: node scripts/verify-native-artifact.mjs <app.aab|app.apk>
//        [--channel internal|preview|production] [--build-id <sha>]
//        [--gradle android/app/build.gradle]
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyWebBundle } from "./verify-web-bundle.mjs";
import { readWranglerPublicVars } from "../build/wrangler-public-vars.mjs";

const NATIVE_AUTH_CALLBACK = "app.verbete.game://auth/callback";

/** Valores (únicos) de uma chave do objeto import.meta.env serializado pelo Vite. */
function envValues(texts, key) {
  const re = new RegExp(`${key}:"([^"]*)"`, "g");
  const out = new Set();
  for (const t of texts) for (const m of t.matchAll(re)) out.add(m[1]);
  return [...out];
}

/**
 * Checagens do bundle nativo (puras: recebem os textos JS/HTML).
 * @param {{ texts: string[], channel?: string, versionName?: string, versionCode?: number }} o
 * @returns {{ problems: string[], facts: Record<string, string | number> }}
 */
export function checkNativeBundle({
  texts,
  channel,
  versionName,
  versionCode,
}) {
  const problems = [];
  const all = texts.join("\n");

  const channels = envValues(texts, "VITE_RELEASE_CHANNEL");
  const names = envValues(texts, "VITE_APP_VERSION_NAME");
  const codes = envValues(texts, "VITE_NATIVE_VERSION_CODE");
  const facts = {
    canal: channels.join(",") || "-",
    versionName: names.join(",") || "-",
    versionCode: codes.join(",") || "-",
    rodapeTesteInterno: all.includes("Teste interno") ? 1 : 0,
  };

  if (channels.length !== 1) {
    problems.push(
      `canal do rodapé não identificado de forma única no bundle (${channels.length} valores)`,
    );
  } else if (channel && channels[0] !== channel) {
    problems.push(`canal do bundle = "${channels[0]}", esperado "${channel}"`);
  }
  // Canal de loja: o ramo "Teste interno" do rodapé é eliminado no build.
  if ((channel ?? channels[0]) === "production" && facts.rodapeTesteInterno) {
    problems.push(
      'canal production, mas o texto "Teste interno" está no bundle',
    );
  }
  if (versionName && (names.length !== 1 || names[0] !== versionName)) {
    problems.push(
      `versionName do bundle (${facts.versionName}) ≠ build.gradle (${versionName})`,
    );
  }
  if (versionCode && (codes.length !== 1 || Number(codes[0]) !== versionCode)) {
    problems.push(
      `versionCode do bundle (${facts.versionCode}) ≠ build.gradle (${versionCode})`,
    );
  }
  // O retorno é montado como `${esquema}://auth/callback` (auth-redirect.ts):
  // mesmo critério do smoke-native-bundle.mjs.
  if (!(/"app\.verbete\.game"/.test(all) && all.includes("://auth/callback"))) {
    problems.push(
      `retorno do login nativo (${NATIVE_AUTH_CALLBACK}) ausente do bundle`,
    );
  }
  if (!/flowType:"pkce"/.test(all))
    problems.push('cliente do Supabase sem flowType:"pkce" no bundle');
  return { problems, facts };
}

function readGradleVersion(path) {
  const g = readFileSync(path, "utf8");
  const code = g.match(/versionCode\s+(\d+)/)?.[1];
  const name = g.match(/versionName\s+"([^"]+)"/)?.[1];
  return { versionCode: code ? Number(code) : undefined, versionName: name };
}

function textFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...textFiles(p));
    else if (/\.(m?js|html|css|json)$/.test(name)) out.push(p);
  }
  return out;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const artifact = args.find(
    (a, k) =>
      !a.startsWith("--") && !String(args[k - 1] ?? "").startsWith("--"),
  );
  if (!artifact || !existsSync(artifact)) {
    console.error(
      "uso: node scripts/verify-native-artifact.mjs <app.aab|app.apk> [--channel c] [--build-id sha]",
    );
    process.exit(2);
  }
  const tmp = mkdtempSync(join(tmpdir(), "verbete-native-"));
  try {
    const unz = spawnSync("unzip", ["-q", "-o", resolve(artifact), "-d", tmp], {
      encoding: "utf8",
    });
    if (unz.status !== 0) {
      console.error(
        `[verify-native-artifact] falha ao abrir o artefato (unzip exit=${unz.status}) ${unz.stderr ?? ""}`,
      );
      process.exit(1);
    }
    const pub = [
      join(tmp, "base", "assets", "public"),
      join(tmp, "assets", "public"),
    ].find((d) => existsSync(d));
    if (!pub) {
      console.error(
        "[verify-native-artifact] REPROVADO: bundle web ausente (base/assets/public ou assets/public)",
      );
      process.exit(1);
    }
    // verifyWebBundle lê <dist>/client: o assets/public vira dist/client.
    const dist = join(tmp, "dist");
    mkdirSync(dist);
    renameSync(pub, join(dist, "client"));

    const vars = readWranglerPublicVars(join(root, "wrangler.jsonc"));
    const web = verifyWebBundle({
      distDir: dist,
      expectedUrl: vars.SUPABASE_URL,
      expectedKey: vars.SUPABASE_PUBLISHABLE_KEY,
      buildId: opt("--build-id"),
    });
    const gradle = readGradleVersion(
      opt("--gradle") ?? join(root, "android/app/build.gradle"),
    );
    const texts = textFiles(join(dist, "client")).map((f) =>
      readFileSync(f, "utf8"),
    );
    const nat = checkNativeBundle({
      texts,
      channel: opt("--channel"),
      ...gradle,
    });

    console.log(`[verify-native-artifact] web ${JSON.stringify(web.facts)}`);
    console.log(`[verify-native-artifact] nativo ${JSON.stringify(nat.facts)}`);
    const problems = [...web.problems, ...nat.problems];
    if (problems.length) {
      console.error(
        `[verify-native-artifact] REPROVADO:\n  • ${problems.join("\n  • ")}`,
      );
      process.exit(1);
    }
    console.log(
      "[verify-native-artifact] OK — configuração pública presente, sem segredos, canal e versão conferidos",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
