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
// Canvas adaptativo 108 dp; o tile (46 dp, cantos arredondados, com a sombra
// 3D de baixo) cabe no círculo seguro de 66 dp (raio 33 dp) — conferido abaixo
// pixel a pixel. Legado: 48 dp, sem encostar na borda.
const ADAPTIVE_DP = 108;
const TILE_DP = 46;
const SAFE_RADIUS_DP = 33;
const LEGACY_DP = 48;

// A sombra 3D de baixo do tile (0 12s 0) fica fora da caixa dele: centraliza
// o CONJUNTO tile + sombra (sobe o tile metade da sombra).
const lifted = (html, size) =>
  `<div style="padding-bottom:${Math.round((12 * size) / 124)}px">${html}</div>`;

const browser = await chromium.launch();

// Alcance do desenho: maior distância do centro com alfa > 25 e quantos
// pixels visíveis (alfa > 10) encostam na borda do PNG.
async function alphaStats(file) {
  const pg = await browser.newPage();
  const src = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  const stats = await pg.evaluate(async (s) => {
    const img = new Image();
    img.src = s;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const {
      data,
      width: w,
      height: h,
    } = ctx.getImageData(0, 0, img.width, img.height);
    let maxR = 0;
    let edge = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (a > 25)
          maxR = Math.max(maxR, Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2));
        if (a > 10 && (x === 0 || y === 0 || x === w - 1 || y === h - 1))
          edge++;
      }
    return { maxR, edge };
  }, src);
  await pg.close();
  return stats;
}
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
  // camada da frente (transparente) e monocromática (só o glifo, na mesma
  // posição do glifo da frente)
  await shot(
    resolve(dir, "ic_launcher_foreground.png"),
    canvas,
    "transparent",
    lifted(tileHtml(tile, { glow: false }), tile),
    true,
  );
  await shot(
    resolve(dir, "ic_launcher_monochrome.png"),
    canvas,
    "transparent",
    lifted(glyphHtml(tile), tile),
    true,
  );
  // legado quadrado: o tile; redondo: o tile sobre círculo creme
  const sq = Math.round(legacy * 0.8);
  await shot(
    resolve(dir, "ic_launcher.png"),
    legacy,
    "transparent",
    lifted(tileHtml(sq, { glow: false }), sq),
    true,
  );
  const rd = Math.round(legacy * 0.58);
  await shot(
    resolve(dir, "ic_launcher_round.png"),
    legacy,
    "transparent",
    `<div style="width:${legacy}px;height:${legacy}px;border-radius:50%;background:${CREAM};display:flex;align-items:center;justify-content:center;">${lifted(tileHtml(rd, { glow: false }), rd)}</div>`,
    true,
  );
  // Conferência pixel a pixel: frente e monocromático dentro do círculo
  // seguro; legado quadrado sem encostar na borda (sombra inteira).
  for (const f of ["ic_launcher_foreground", "ic_launcher_monochrome"]) {
    const { maxR } = await alphaStats(resolve(dir, `${f}.png`));
    if (maxR > SAFE_RADIUS_DP * d)
      throw new Error(
        `${name}/${f}: desenho a ${(maxR / d).toFixed(1)} dp do centro (> ${SAFE_RADIUS_DP} dp)`,
      );
  }
  const { edge } = await alphaStats(resolve(dir, "ic_launcher.png"));
  if (edge > 0)
    throw new Error(
      `${name}/ic_launcher: ${edge} pixel(s) encostando na borda`,
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
