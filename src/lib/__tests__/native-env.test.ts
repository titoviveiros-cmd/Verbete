import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNativeEnv,
  jwtRole,
  nativeEnvProblems,
  readAndroidVersion,
  readAndroidVersionCode,
  resolveReleaseChannel,
} from "../../../build/native-env";

const ROOT = resolve(__dirname, "../../..");
const jwt = (payload: object) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const valid = {
  VITE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abcdefghijklmnop",
  VITE_APP_URL: "https://jogo.verbete.workers.dev",
};

describe("trava do build nativo", () => {
  it("aceita a configuração pública completa", () => {
    expect(nativeEnvProblems(valid)).toEqual([]);
    expect(() => assertNativeEnv(valid)).not.toThrow();
  });

  it("FALHA sem URL, sem chave ou sem APP_URL (o APK nasceria morto)", () => {
    expect(
      nativeEnvProblems({ ...valid, VITE_SUPABASE_URL: undefined }),
    ).toHaveLength(1);
    expect(
      nativeEnvProblems({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: "" }),
    ).toHaveLength(1);
    expect(
      nativeEnvProblems({ ...valid, VITE_APP_URL: undefined }),
    ).toHaveLength(1);
    expect(() => assertNativeEnv({})).toThrow(/Build nativo bloqueado/);
  });

  it("FALHA com chave secreta ou service_role no client", () => {
    expect(
      nativeEnvProblems({
        ...valid,
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_xxxxxxxxxxxx",
      })[0],
    ).toMatch(/SECRETA/);
    expect(
      nativeEnvProblems({
        ...valid,
        VITE_SUPABASE_PUBLISHABLE_KEY: jwt({ role: "service_role" }),
      })[0],
    ).toMatch(/service_role/);
  });

  it("aceita a chave anon legada (JWT)", () => {
    expect(jwtRole(jwt({ role: "anon" }))).toBe("anon");
    expect(
      nativeEnvProblems({
        ...valid,
        VITE_SUPABASE_PUBLISHABLE_KEY: jwt({ role: "anon" }),
      }),
    ).toEqual([]);
  });

  it("FALHA com APP_URL local (link de convite apontaria para o próprio aparelho)", () => {
    for (const bad of [
      "http://localhost:5173",
      "https://localhost",
      "capacitor://localhost",
    ]) {
      expect(nativeEnvProblems({ ...valid, VITE_APP_URL: bad })).toHaveLength(
        1,
      );
    }
  });

  it("o .env.capacitor versionado passa na trava e só tem valores públicos", () => {
    const file = readFileSync(resolve(ROOT, ".env.capacitor"), "utf8");
    const env = Object.fromEntries(
      file
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [
          l.slice(0, l.indexOf("=")),
          l.slice(l.indexOf("=") + 1).trim(),
        ]),
    );
    expect(nativeEnvProblems(env)).toEqual([]);
    expect(file).not.toMatch(
      /sb_secret_|service_role|SERVICE_ROLE|GEMINI|postgres:/i,
    );
  });

  it("lê o versionCode do Android (fonte da trava de versão mínima)", () => {
    expect(
      readAndroidVersionCode(resolve(ROOT, "android/app/build.gradle")),
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("versão do app (rodapé da Home)", () => {
  const GRADLE = resolve(ROOT, "android/app/build.gradle");

  it("versionName e versionCode saem do build.gradle — a mesma fonte do APK", () => {
    const gradle = readFileSync(GRADLE, "utf8");
    const v = readAndroidVersion(GRADLE);
    expect(v.versionName).toBe(gradle.match(/versionName\s+"([^"]+)"/)?.[1]);
    expect(v.versionCode).toBe(
      Number(gradle.match(/versionCode\s+(\d+)/)?.[1]),
    );
    expect(v.versionCode).toBe(readAndroidVersionCode(GRADLE));
  });

  it("FALHA sem versionName no build.gradle (não inventa versão)", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbete-gradle-"));
    const file = join(dir, "build.gradle");
    writeFileSync(
      file,
      "android {\n  defaultConfig {\n    versionCode 7\n  }\n}\n",
    );
    expect(() => readAndroidVersion(file)).toThrow(/versionName/);
  });

  it("canal decidido no build: nativo = teste interno, web = produção", () => {
    expect(resolveReleaseChannel(undefined, true)).toBe("internal");
    expect(resolveReleaseChannel("", true)).toBe("internal");
    expect(resolveReleaseChannel(undefined, false)).toBe("production");
    expect(resolveReleaseChannel("production", true)).toBe("production");
    expect(resolveReleaseChannel("preview", false)).toBe("preview");
    expect(resolveReleaseChannel(" internal ", false)).toBe("internal");
  });

  it("canal desconhecido BLOQUEIA o build (erro de digitação ≠ rodapé errado)", () => {
    expect(() => resolveReleaseChannel("prod", true)).toThrow(
      /VITE_RELEASE_CHANNEL inválido/,
    );
    expect(() => resolveReleaseChannel("Production", false)).toThrow();
  });
});
