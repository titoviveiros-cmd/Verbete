import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shortSha, versionLabel } from "../version-label";
import { readAndroidVersion } from "../../../build/native-env";

const ROOT = resolve(__dirname, "../../..");
const SHA = "62fb060a12c56f78632f0617e83db6e9297d03ed";

describe("rodapé de versão da Home — texto por canal", () => {
  it("teste interno: versionName, versionCode e SHA curto", () => {
    expect(
      versionLabel({
        channel: "internal",
        versionName: "2.1.2",
        versionCode: 6,
        buildId: SHA,
      }),
    ).toBe("Teste interno · v2.1.2 (6) · 62fb060");
  });

  it("preview: versionName e SHA, sem versionCode", () => {
    expect(
      versionLabel({
        channel: "preview",
        versionName: "2.1.2",
        versionCode: 6,
        buildId: SHA,
      }),
    ).toBe("Preview · v2.1.2 · 62fb060");
  });

  it("produção: só a versão — nada de infra no rodapé público", () => {
    for (const versionCode of [6, null])
      for (const buildId of [SHA, "dev", undefined]) {
        const label = versionLabel({
          channel: "production",
          versionName: "2.1.2",
          versionCode,
          buildId,
        });
        expect(label).toBe("v2.1.2");
        expect(label).not.toMatch(/Teste|Preview|\(|·|[0-9a-f]{7}/);
      }
  });

  it('build sem SHA ("dev") não inventa um: o trecho some', () => {
    expect(
      versionLabel({
        channel: "internal",
        versionName: "2.1.2",
        versionCode: 6,
        buildId: "dev",
      }),
    ).toBe("Teste interno · v2.1.2 (6)");
    expect(shortSha("dev")).toBeNull();
    expect(shortSha(undefined)).toBeNull();
    expect(shortSha("ABCDEF1234")).toBe("abcdef1");
  });

  it("sem versionName não há rodapé (nunca uma versão inventada)", () => {
    expect(
      versionLabel({
        channel: "internal",
        versionName: undefined,
        buildId: SHA,
      }),
    ).toBeNull();
  });
});

describe("rodapé de versão da Home — tudo vem do build", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const labelWith = async (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules();
    return (await import("../app-version")).APP_VERSION_LABEL;
  };

  it("versionName, versionCode, SHA e canal são os que o build injetou", async () => {
    expect(
      await labelWith({
        VITE_APP_VERSION_NAME: "9.8.7",
        VITE_NATIVE_VERSION_CODE: "42",
        VITE_BUILD_ID: "abcdef0123456789",
        VITE_RELEASE_CHANNEL: "internal",
      }),
    ).toBe("Teste interno · v9.8.7 (42) · abcdef0");
  });

  it("o mesmo build em produção mostra só a versão", async () => {
    expect(
      await labelWith({
        VITE_APP_VERSION_NAME: "9.8.7",
        VITE_NATIVE_VERSION_CODE: "42",
        VITE_BUILD_ID: "abcdef0123456789",
        VITE_RELEASE_CHANNEL: "production",
      }),
    ).toBe("v9.8.7");
  });

  it("canal estranho no bundle cai no texto mínimo (o build já o recusa)", async () => {
    expect(
      await labelWith({
        VITE_APP_VERSION_NAME: "9.8.7",
        VITE_BUILD_ID: "abcdef0123456789",
        VITE_RELEASE_CHANNEL: "qualquer",
      }),
    ).toBe("v9.8.7");
  });

  it("a Home só exibe o texto pronto: nenhuma versão ou SHA escrito no componente", () => {
    const home = readFileSync(resolve(ROOT, "src/routes/index.tsx"), "utf8");
    const { versionName, versionCode } = readAndroidVersion(
      resolve(ROOT, "android/app/build.gradle"),
    );
    expect(home).toMatch(/\{APP_VERSION_LABEL\}/);
    expect(home).not.toContain(versionName);
    expect(home).not.toMatch(new RegExp(`\\(${versionCode}\\)`));
    // SHA = hex com letra E dígito (não pega palavras como "acabada")
    expect(home).not.toMatch(
      /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/,
    );
  });

  it("o vite.config injeta a versão do build.gradle e o canal do build", () => {
    const cfg = readFileSync(resolve(ROOT, "vite.config.ts"), "utf8");
    expect(cfg).toMatch(
      /appVersion = readAndroidVersion\("android\/app\/build\.gradle"\)/,
    );
    expect(cfg).toMatch(
      /process\.env\.VITE_APP_VERSION_NAME = appVersion\.versionName/,
    );
    expect(cfg).toMatch(
      /process\.env\.VITE_NATIVE_VERSION_CODE = String\(appVersion\.versionCode\)/,
    );
    expect(cfg).toMatch(
      /process\.env\.VITE_RELEASE_CHANNEL = resolveReleaseChannel\(/,
    );
  });
});
