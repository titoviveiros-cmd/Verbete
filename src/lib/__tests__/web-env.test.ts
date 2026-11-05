// Trava do build web + verificação positiva do bundle (incidente P1 de
// 05/11/2026: Worker publicado com cliente sem VITE_SUPABASE_URL/KEY).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWebEnv, webEnvProblems } from "../../../build/web-env";
import {
  parseJsonc,
  readWranglerPublicVars,
} from "../../../build/wrangler-public-vars.mjs";
import { verifyWebBundle } from "../../../scripts/verify-web-bundle.mjs";

const ROOT = resolve(__dirname, "../../..");
const jwt = (payload: object) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.assinatura0123`;
const URL_OK = "https://abcdefghijklmnopqrst.supabase.co";
const KEY_OK = "sb_publishable_abcdefghijklmnop";
const valid = {
  VITE_SUPABASE_URL: URL_OK,
  VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK,
};

describe("trava do build web", () => {
  it("aceita a configuração pública completa (VITE_APP_URL é opcional no web)", () => {
    expect(webEnvProblems(valid)).toEqual([]);
    expect(() => assertWebEnv(valid)).not.toThrow();
    expect(
      webEnvProblems({
        ...valid,
        VITE_APP_URL: "https://jogo.verbete.workers.dev",
      }),
    ).toEqual([]);
  });

  it("BLOQUEIA o caso do incidente: build sem URL e sem chave", () => {
    expect(() => assertWebEnv({})).toThrow(/Build web bloqueado/);
    const p = webEnvProblems({
      VITE_APP_URL: "https://jogo.verbete.workers.dev",
    });
    expect(p.join("|")).toMatch(/VITE_SUPABASE_URL/);
    expect(p.join("|")).toMatch(/VITE_SUPABASE_PUBLISHABLE_KEY ausente/);
  });

  it("bloqueia cada variável faltando isoladamente", () => {
    expect(
      webEnvProblems({ VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK }),
    ).toHaveLength(1);
    expect(webEnvProblems({ VITE_SUPABASE_URL: URL_OK })).toHaveLength(1);
    expect(webEnvProblems({ ...valid, VITE_SUPABASE_URL: "   " })).toHaveLength(
      1,
    );
  });

  it("bloqueia URL local/http e chave secreta ou service_role", () => {
    expect(
      webEnvProblems({ ...valid, VITE_SUPABASE_URL: "http://127.0.0.1:54321" }),
    ).toHaveLength(1);
    expect(
      webEnvProblems({ ...valid, VITE_SUPABASE_URL: "https://localhost" }),
    ).toHaveLength(1);
    expect(
      webEnvProblems({
        ...valid,
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_abcdefghijklmnop",
      }).join(),
    ).toMatch(/SECRETA/);
    expect(
      webEnvProblems({
        ...valid,
        VITE_SUPABASE_PUBLISHABLE_KEY: jwt({ role: "service_role" }),
      }).join(),
    ).toMatch(/service_role/);
    expect(
      webEnvProblems({
        ...valid,
        VITE_SUPABASE_PUBLISHABLE_KEY: jwt({ role: "anon" }),
      }),
    ).toEqual([]);
    expect(
      webEnvProblems({ ...valid, VITE_APP_URL: "http://localhost:5173" }),
    ).toHaveLength(1);
  });

  it("a mensagem NUNCA contém o valor da chave", () => {
    const secret = "sb_secret_naoPodeAparecer123456";
    try {
      assertWebEnv({
        VITE_SUPABASE_URL: URL_OK,
        VITE_SUPABASE_PUBLISHABLE_KEY: secret,
      });
      throw new Error("deveria ter bloqueado");
    } catch (e) {
      expect(String(e)).toMatch(/Build web bloqueado/);
      expect(String(e)).not.toContain(secret);
    }
  });

  it("vite.config chama a trava no build web (fora do capacitor e do modo development)", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    expect(cfg).toMatch(
      /command === "build" && !isCapacitor && mode !== "development"[\s\S]{0,80}assertWebEnv\(loadEnv\(mode, process\.cwd\(\), "VITE_"\)\)/,
    );
  });
});

describe("configuração pública de wrangler.jsonc (fonte única do cliente web)", () => {
  it("lê JSONC com comentários e vírgulas finais", () => {
    expect(
      parseJsonc('{\n // c\n "vars": { "A": "x//y", /* b */ "B": "z", },\n}'),
    ).toEqual({ vars: { A: "x//y", B: "z" } });
  });

  it("o wrangler.jsonc do repo tem URL https pública e chave PUBLICÁVEL (não secreta)", () => {
    const v = readWranglerPublicVars(join(ROOT, "wrangler.jsonc"));
    expect(
      webEnvProblems({
        VITE_SUPABASE_URL: v.SUPABASE_URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: v.SUPABASE_PUBLISHABLE_KEY,
      }),
    ).toEqual([]);
    expect(v.SUPABASE_PUBLISHABLE_KEY).toMatch(/^sb_publishable_/);
  });
});

describe("verificação positiva do bundle web", () => {
  const mk = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "verbete-bundle-"));
    mkdirSync(join(dir, "client", "assets"), { recursive: true });
    for (const [n, c] of Object.entries(files))
      writeFileSync(join(dir, "client", n), c);
    return dir;
  };
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const good = `const u="${URL_OK}",k="${KEY_OK}",b="${SHA}";`;

  it("aprova bundle com URL, chave e build ID esperados", () => {
    const r = verifyWebBundle({
      distDir: mk({ "assets/a.js": good }),
      expectedUrl: URL_OK,
      expectedKey: KEY_OK,
      buildId: SHA,
    });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("REPROVA o bundle do incidente (sem URL e sem chave), mesmo sem mensagem de erro no texto", () => {
    const r = verifyWebBundle({
      distDir: mk({ "assets/a.js": `const b="${SHA}";` }),
      expectedUrl: URL_OK,
      expectedKey: KEY_OK,
      buildId: SHA,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("|")).toMatch(/VITE_SUPABASE_URL esperada NÃO/);
    expect(r.problems.join("|")).toMatch(/PUBLISHABLE_KEY esperada NÃO/);
  });

  it("reprova build ID errado, pasta ausente e expectativa não informada", () => {
    expect(
      verifyWebBundle({
        distDir: mk({ "assets/a.js": good }),
        expectedUrl: URL_OK,
        expectedKey: KEY_OK,
        buildId: "f".repeat(40),
      }).ok,
    ).toBe(false);
    expect(
      verifyWebBundle({
        distDir: join(tmpdir(), "nao-existe-xyz"),
        expectedUrl: URL_OK,
        expectedKey: KEY_OK,
      }).ok,
    ).toBe(false);
    expect(verifyWebBundle({ distDir: mk({ "assets/a.js": good }) }).ok).toBe(
      false,
    );
  });

  it("reprova segredo administrativo no cliente (sem expor o valor)", () => {
    for (const leak of [
      "sb_secret_abcdefghijklmnop",
      `sbp_${"a".repeat(40)}`,
      jwt({ role: "service_role" }),
      `AIza${"B".repeat(35)}`,
    ]) {
      const r = verifyWebBundle({
        distDir: mk({ "assets/a.js": good + `const x="${leak}";` }),
        expectedUrl: URL_OK,
        expectedKey: KEY_OK,
      });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(leak);
    }
    // chave anon (JWT público) não é segredo
    expect(
      verifyWebBundle({
        distDir: mk({
          "assets/a.js": good + `const x="${jwt({ role: "anon" })}";`,
        }),
        expectedUrl: URL_OK,
        expectedKey: KEY_OK,
      }).ok,
    ).toBe(true);
  });
});
