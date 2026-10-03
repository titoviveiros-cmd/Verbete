// Build Android (Gradle, APK de DEBUG) no CI do PR — enquanto o android.yml
// não roda em pull requests (o commit que liga isso exige token com escopo
// `workflow`; até lá este estágio cobre a mesma trilha). Nada de AAB nem
// secrets: a release assinada continua só no workflow_dispatch.
// Só roda no CI com Android SDK presente; fora disso é no-op.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

if (!process.env.CI || !process.env.ANDROID_HOME) {
  console.log("pulado: fora do CI ou sem ANDROID_HOME");
  process.exit(0);
}
let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const sha = process.env.GITHUB_SHA ?? "";
const env = {
  ...process.env,
  VITE_BUILD_ID: sha,
  JAVA_HOME: process.env.JAVA_HOME_21_X64 ?? process.env.JAVA_HOME,
};
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", env, ...opts });

console.log("— Trava: sem a chave pública o build nativo NÃO sai");
const neg = run("npx", ["vite", "build", "--mode", "capacitor"], {
  capture: true,
  env: { ...env, VITE_SUPABASE_PUBLISHABLE_KEY: "" },
});
check(
  "vite build --mode capacitor com chave vazia FALHA (nenhum APK/AAB natimorto)",
  neg.status !== 0 && /Build nativo bloqueado/.test(`${neg.stdout}${neg.stderr}`),
  `exit=${neg.status}`,
);

console.log("\n— Build Capacitor + smoke do bundle");
check("vite build --mode capacitor (config pública versionada)", run("npx", ["vite", "build", "--mode", "capacitor"]).status === 0);
check(
  "smoke do bundle nativo",
  run("node", ["scripts/smoke-native-bundle.mjs", "dist/client"], {
    env: { ...env, EXPECT_BUILD_ID: sha, EXPECT_SUPABASE_URL: "https://wspztmimctgbjcmyzexn.supabase.co" },
  }).status === 0,
);
check("cap sync android", run("npx", ["cap", "sync", "android"]).status === 0);

console.log("\n— Gradle (Android)");
run("chmod", ["+x", "android/gradlew"]);
const gradle = run("./gradlew", ["assembleDebug", "testDebugUnitTest", "--no-daemon", "--stacktrace"], {
  cwd: "android",
});
check("gradlew assembleDebug testDebugUnitTest", gradle.status === 0, `exit=${gradle.status}`);

const apk = "android/app/build/outputs/apk/debug/app-debug.apk";
check("APK de debug gerado", existsSync(apk));
if (existsSync(apk)) {
  const plugins = run("unzip", ["-p", apk, "assets/capacitor.plugins.json"], { capture: true }).stdout ?? "";
  check("plugin de compartilhamento nativo registrado no APK", /@capacitor\/share/.test(plugins), plugins.slice(0, 160));
  const bt = join(process.env.ANDROID_HOME, "build-tools");
  const ver = existsSync(bt) ? readdirSync(bt).sort().at(-1) : undefined;
  const perms = ver
    ? run(join(bt, ver, "aapt2"), ["dump", "permissions", apk], { capture: true }).stdout ?? ""
    : "";
  check(
    "permissões do APK: internet + vibração (haptics)",
    /android\.permission\.INTERNET/.test(perms) && /android\.permission\.VIBRATE/.test(perms),
    perms.replace(/\s+/g, " ").slice(0, 200),
  );
  const cfg = run("unzip", ["-p", apk, "assets/public/index.html"], { capture: true }).stdout ?? "";
  check("bundle embarcado no APK traz o build id do commit", sha !== "" && cfg.includes(sha), `sha=${sha.slice(0, 7)}`);
}

console.log(fails ? `\n${fails}/${total} FALHAS` : `\nANDROID OK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
