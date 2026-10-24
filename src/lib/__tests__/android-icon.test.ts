import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Ícone do launcher Android (2.1.1): instalado pela Play, o Verbete apareceu
// com FUNDO PRETO — o fundo adaptativo era #0f0a1f (identidade escura de
// julho), com inset de 16,7% (borda transparente, que launchers pintam de
// preto) e camadas de 48 dp em vez de 108 dp. Gerado agora por
// scripts/gen-android-icon.mjs a partir do VerbeteTile oficial.
const ROOT = join(__dirname, "..", "..", "..");
const RES = join(ROOT, "android", "app", "src", "main", "res");
const read = (p: string) => readFileSync(join(RES, p), "utf8");
const png = (p: string) => {
  const b = readFileSync(join(RES, p));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
};
const DENSITIES: Record<string, number> = {
  ldpi: 0.75,
  mdpi: 1,
  hdpi: 1.5,
  xhdpi: 2,
  xxhdpi: 3,
  xxxhdpi: 4,
};

describe("ícone adaptativo do Android", () => {
  for (const f of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
    it(`${f}: fundo = cor do app sem inset; frente e monocromático próprios`, () => {
      const x = read(`mipmap-anydpi-v26/${f}`);
      expect(x).toMatch(
        /<background android:drawable="@color\/ic_launcher_background"\s*\/>/,
      );
      expect(x).toMatch(
        /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\s*\/>/,
      );
      expect(x).toMatch(
        /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"\s*\/>/,
      );
      expect(x).not.toMatch(/<inset/);
    });
  }

  it("cor do fundo = fundo do app (capacitor.config) e clara — nada de preto", () => {
    const color =
      read("values/ic_launcher_background.xml").match(
        /#([0-9a-fA-F]{6})/,
      )?.[1] ?? "";
    const cap = readFileSync(join(ROOT, "capacitor.config.ts"), "utf8");
    const appBg =
      cap.match(
        /android:\s*{[^}]*backgroundColor:\s*"#([0-9a-fA-F]{6})"/,
      )?.[1] ?? "";
    expect(appBg).not.toBe("");
    expect(color.toLowerCase()).toBe(appBg.toLowerCase());
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16));
    expect(0.2126 * r! + 0.7152 * g! + 0.0722 * b!).toBeGreaterThan(200);
  });

  it("camadas no canvas de 108 dp (com transparência) e legados de 48 dp, em todas as densidades", () => {
    for (const [d, k] of Object.entries(DENSITIES)) {
      const layer = Math.round(108 * k);
      const legacy = Math.round(48 * k);
      for (const f of ["ic_launcher_foreground", "ic_launcher_monochrome"]) {
        const p = png(`mipmap-${d}/${f}.png`);
        expect([p.w, p.h, p.colorType], `${d}/${f}`).toEqual([layer, layer, 6]);
      }
      for (const f of ["ic_launcher", "ic_launcher_round"]) {
        const p = png(`mipmap-${d}/${f}.png`);
        expect([p.w, p.h], `${d}/${f}`).toEqual([legacy, legacy]);
      }
      expect(
        existsSync(join(RES, `mipmap-${d}`, "ic_launcher_background.png")),
      ).toBe(false);
    }
  });
});
