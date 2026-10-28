// Ícones web/PWA (hotfix 28/10/2026): os PNGs que o head e o manifest
// declaravam não existiam (404 em produção) e o iPhone criava um "V" cinza
// genérico na Tela de Início. Todos saem do ícone aprovado da Play
// (scripts/store/gen-web-icons.mjs).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const pub = (f: string) => readFileSync(resolve(ROOT, "public", f));
const png = (buf: Buffer) => ({
  sig: buf.subarray(0, 8).toString("hex"),
  w: buf.readUInt32BE(16),
  h: buf.readUInt32BE(20),
  colorType: buf.readUInt8(25),
});
const PNG_SIG = "89504e470d0a1a0a";
const APPROVED =
  "19b1b903960a422059a2ba3655af61ca0d47de2f46b143c78063a1ee2e5ab5a4";

describe("ícones web/PWA", () => {
  it.each([
    ["apple-touch-icon.png", 180],
    ["apple-touch-icon-verbete-v1.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["favicon.png", 64],
  ])("%s é PNG %ipx quadrado e opaco", (file, size) => {
    const p = png(pub(file));
    expect(p.sig).toBe(PNG_SIG);
    expect([p.w, p.h]).toEqual([size, size]);
    expect([2, 6]).toContain(p.colorType); // RGB, ou RGBA do original (alpha 255)
  });

  it("icon-512.png é exatamente a arte aprovada da Play", () => {
    expect(createHash("sha256").update(pub("icon-512.png")).digest("hex")).toBe(
      APPROVED,
    );
  });

  it("as duas URLs do Apple Touch Icon servem a mesma imagem", () => {
    expect(
      pub("apple-touch-icon.png").equals(
        pub("apple-touch-icon-verbete-v1.png"),
      ),
    ).toBe(true);
  });

  it("head e manifest apontam só para arquivos que existem", () => {
    const root = readFileSync(resolve(ROOT, "src/routes/__root.tsx"), "utf8");
    expect(root).toContain('href: "/apple-touch-icon-verbete-v1.png"');
    expect(root).toContain('href: "/favicon.png"');
    const manifest = JSON.parse(pub("manifest.webmanifest").toString("utf8"));
    expect(manifest).toMatchObject({
      name: "Verbete",
      short_name: "Verbete",
      display: "standalone",
      start_url: "/",
      background_color: "#fbf3e3",
      theme_color: "#fbf3e3",
    });
    for (const icon of manifest.icons) {
      const p = png(pub(icon.src.replace(/^\//, "")));
      expect(`${p.w}x${p.h}`).toBe(icon.sizes);
    }
  });
});
