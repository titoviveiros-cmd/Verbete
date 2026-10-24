// Ícone do launcher Android (2.1.1) a partir do VerbeteTile oficial
// (scripts/lib/brand-tile.mjs = VerbeteLogo.tsx), renderizado via Chromium.
//
// Antes: fundo adaptativo #0f0a1f (identidade escura de julho, quase preto),
// camadas com 48 dp em vez de 108 dp e `inset 16.7%` no FUNDO — sobrava uma
// borda transparente que os launchers pintam de preto. Agora:
//   - fundo: cor sólida creme #fbf3e3 (@color/ic_launcher_background) — a cor
//     de fundo do app (capacitor.config, manifest web, splash/status bar);
//   - frente: o tile no canvas de 108 dp, inteiro dentro do círculo seguro de
//     66 dp (cabe em qualquer máscara: círculo, squircle, gota, quadrado);
//   - monocromático (ícone temático do Android 13+): só o "V" e o livro;
//   - legados (Android 7.x — minSdk 24): o próprio tile (quadrado) e o tile
//     sobre círculo creme (redondo).
// Uso: node scripts/gen-android-icon.mjs [pasta-de-prévia]
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { glyphHtml, page, tileHtml } from "./lib/brand-tile.mjs";

const RES = resolve(process.cwd(), "android/app/src/main/res");
const CREAM = "#fbf3e3";
const DENSITIES = {
  ldpi: 0.75,
  mdpi: 1,
  hdpi: 1.5,
  xhdpi: 2,
  xxhdpi: 3,
  xxxhdpi: 4,
};
// Canvas adaptativo 108 dp; o tile (48 dp, cantos arredondados, com a sombra) cabe no
// círculo seguro de 66 dp com folga. Legado: 48 dp.
const ADAPTIVE_DP = 108;
const TILE_DP = 48;
const LEGACY_DP = 48;

const browser = await chromium.launch();
async function shot(file, px, bodyBg, inner, transparent) {
  const pg = await browser.newPage({
    viewport: { width: px, height: px },
    deviceScaleFactor: 1,
  });
  await pg.setContent(page(bodyBg, inner), { waitUntil: "networkidle" });
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(150);
  await pg.screenshot({ path: file, omitBackground: transparent });
  await pg.close();
}

for (const [name, d] of Object.entries(DENSITIES)) {
  const dir = resolve(RES, `mipmap-${name}`);
  const canvas = Math.round(ADAPTIVE_DP * d);
  const tile = Math.round(TILE_DP * d);
  const legacy = Math.round(LEGACY_DP * d);
  // camada da frente (transparente) e monocromática (só o glifo)
  await shot(
    resolve(dir, "ic_launcher_foreground.png"),
    canvas,
    "transparent",
    tileHtml(tile, { glow: false }),
    true,
  );
  await shot(
    resolve(dir, "ic_launcher_monochrome.png"),
    canvas,
    "transparent",
    glyphHtml(tile),
    true,
  );
  // legado quadrado: o tile; redondo: o tile sobre círculo creme
  await shot(
    resolve(dir, "ic_launcher.png"),
    legacy,
    "transparent",
    tileHtml(Math.round(legacy * 0.84), { glow: false }),
    true,
  );
  await shot(
    resolve(dir, "ic_launcher_round.png"),
    legacy,
    "transparent",
    `<div style="width:${legacy}px;height:${legacy}px;border-radius:50%;background:${CREAM};display:flex;align-items:center;justify-content:center;">${tileHtml(Math.round(legacy * 0.62), { glow: false })}</div>`,
    true,
  );
  // o fundo agora é cor (@color/ic_launcher_background): PNG antigo sai
  const oldBg = resolve(dir, "ic_launcher_background.png");
  if (existsSync(oldBg)) rmSync(oldBg);
  console.log(
    `✔ mipmap-${name}: frente/monocromático ${canvas}px, legados ${legacy}px`,
  );
}

// Prévia renderizada (opcional): o ícone adaptativo como o launcher compõe —
// fundo + frente no canvas de 108 dp, recortado à janela de 72 dp e à máscara.
const previewDir = process.argv[2];
if (previewDir) {
  mkdirSync(previewDir, { recursive: true });
  const fg = resolve(RES, "mipmap-xxxhdpi/ic_launcher_foreground.png");
  const mono = resolve(RES, "mipmap-xxxhdpi/ic_launcher_monochrome.png");
  const url = (p) =>
    `data:image/png;base64,${readFileSync(p).toString("base64")}`;
  const masks = {
    círculo: "50%",
    squircle: "38%",
    "quadrado arredondado": "22%",
    gota: "50% 50% 50% 12%",
  };
  const cell = (label, inner) =>
    `<figure style="margin:0 14px;text-align:center;font:600 15px sans-serif;color:#333">${inner}<figcaption style="margin-top:8px">${label}</figcaption></figure>`;
  const adaptive = (radius, layer, bg, tint) =>
    `<div style="width:192px;height:192px;border-radius:${radius};overflow:hidden;position:relative;background:${bg}">
       <img src="${url(layer)}" style="position:absolute;width:288px;height:288px;left:-48px;top:-48px;${tint ? "filter:brightness(0) saturate(100%) invert(18%) sepia(56%) saturate(2400%) hue-rotate(255deg);" : ""}">
     </div>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#e9e4da">
    <h3 style="font:700 18px sans-serif;margin:0 0 12px">Adaptativo (fundo creme + tile) — máscaras de launcher</h3>
    <div style="display:flex">${Object.entries(masks)
      .map(([k, r]) => cell(k, adaptive(r, fg, CREAM, false)))
      .join("")}</div>
    <h3 style="font:700 18px sans-serif;margin:20px 0 12px">Canvas inteiro de 108 dp (sem borda transparente) · temático (Android 13+) · legados</h3>
    <div style="display:flex;align-items:flex-end">
      ${cell("108 dp inteiro", `<div style="width:192px;height:192px;background:${CREAM};position:relative"><img src="${url(fg)}" style="width:192px;height:192px"></div>`)}
      ${cell("temático", adaptive("50%", mono, "#d9ccf2", true))}
      ${cell("legado", `<img src="${url(resolve(RES, "mipmap-xxxhdpi/ic_launcher.png"))}" style="width:192px;height:192px">`)}
      ${cell("legado redondo", `<img src="${url(resolve(RES, "mipmap-xxxhdpi/ic_launcher_round.png"))}" style="width:192px;height:192px">`)}
    </div></body></html>`;
  const pg = await browser.newPage({ viewport: { width: 1000, height: 620 } });
  await pg.setContent(html, { waitUntil: "load" });
  await pg.waitForTimeout(300);
  await pg.screenshot({
    path: resolve(previewDir, "android-icon-preview.png"),
  });
  await pg.close();
  console.log(`✔ prévia: ${resolve(previewDir, "android-icon-preview.png")}`);
}

await browser.close();
