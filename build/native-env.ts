// Trava do build nativo (vite build --mode capacitor). O APK empacota um
// bundle fixo: configuração ausente ou errada aqui vira app natimorto na loja
// com CI verde (Master Release Audit: MOB-01, VIR-03, RC-02).
import { readFileSync } from "node:fs";

const LOCAL_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$|\.local$|\.localhost$/i;

function publicHttps(raw: string | undefined): URL | null {
  try {
    const u = new URL((raw ?? "").trim());
    return u.protocol === "https:" && !LOCAL_HOST_RE.test(u.hostname)
      ? u
      : null;
  } catch {
    return null;
  }
}

/** Papel declarado num JWT (chaves legadas do Supabase), ou null. */
export function jwtRole(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = Buffer.from(
      part.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const role = (JSON.parse(json) as { role?: unknown }).role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

/** Lista de problemas da configuração pública do bundle nativo (vazia = ok). */
export function nativeEnvProblems(
  env: Record<string, string | undefined>,
): string[] {
  const problems: string[] = [];

  if (!publicHttps(env.VITE_SUPABASE_URL)) {
    problems.push("VITE_SUPABASE_URL ausente ou não é https público");
  }

  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  if (!key) {
    problems.push("VITE_SUPABASE_PUBLISHABLE_KEY ausente");
  } else if (/^sb_secret_/i.test(key)) {
    problems.push(
      "VITE_SUPABASE_PUBLISHABLE_KEY é uma chave SECRETA (sb_secret_) — nunca no client",
    );
  } else if (/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) {
    // formato atual de chave pública
  } else if (jwtRole(key) === "anon") {
    // chave legada anon (JWT)
  } else if (jwtRole(key) === "service_role") {
    problems.push(
      "VITE_SUPABASE_PUBLISHABLE_KEY é service_role — nunca no client",
    );
  } else {
    problems.push(
      "VITE_SUPABASE_PUBLISHABLE_KEY não parece uma chave pública do Supabase",
    );
  }

  if (!publicHttps(env.VITE_APP_URL)) {
    problems.push(
      "VITE_APP_URL ausente ou não é https público (links de convite do app sairiam quebrados)",
    );
  }
  return problems;
}

export function assertNativeEnv(env: Record<string, string | undefined>): void {
  const problems = nativeEnvProblems(env);
  if (problems.length > 0) {
    throw new Error(
      "Build nativo bloqueado — configuração pública inválida:\n  • " +
        problems.join("\n  • ") +
        "\nConfira .env.capacitor (valores públicos) ou as variáveis do CI.",
    );
  }
}

/** versionCode do app Android (fonte única: android/app/build.gradle). */
export function readAndroidVersionCode(gradlePath: string): number {
  const gradle = readFileSync(gradlePath, "utf8");
  const m = gradle.match(/versionCode\s+(\d+)/);
  if (!m) throw new Error(`versionCode não encontrado em ${gradlePath}`);
  return Number(m[1]);
}
