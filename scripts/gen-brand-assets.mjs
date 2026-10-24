// Gera os assets-fonte da marca (resources/) renderizando o VerbeteTile e o
// wordmark com o MESMO visual do hero da Home (VerbeteLogo.tsx), via Chromium
// headless. Depois rode: npm run cap:icons (capacitor-assets generate).
// Ícone do launcher ANDROID: scripts/gen-android-icon.mjs (2.1.1) — o
// template do capacitor-assets põe inset no fundo adaptativo (borda
// transparente → fundo preto em launchers) e o fundo daqui é o escuro antigo.
//
// Saídas:
//   resources/icon-only.png        1024×1024  ícone cheio (fundo #0f0a1f)
//   resources/icon-foreground.png  1024×1024  tile na zona segura (transparente)
//   resources/icon-background.png  1024×1024  fundo sólido #0f0a1f
//   resources/splash.png           2732×2732  tile + wordmark centralizados
//   resources/splash-dark.png      idem (o app é dark-first)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { page, tileHtml, wordmarkHtml } from "./lib/brand-tile.mjs";

const OUT = resolve(process.cwd(), "resources");
mkdirSync(OUT, { recursive: true });

const BG = "#0f0a1f";

const browser = await chromium.launch();
const shots = [
  // Ícone cheio: tile a ~78% com o fundo da marca (launchers aplicam a máscara)
  {
    file: "icon-only.png",
    w: 1024,
    h: 1024,
    bg: BG,
    html: tileHtml(800),
    transparent: false,
  },
  // Foreground adaptativo: zona segura = círculo central de ~61% do canvas
  {
    file: "icon-foreground.png",
    w: 1024,
    h: 1024,
    bg: "transparent",
    html: tileHtml(560, { glow: false }),
    transparent: true,
  },
  {
    file: "icon-background.png",
    w: 1024,
    h: 1024,
    bg: BG,
    html: "",
    transparent: false,
  },
  // Splash: conteúdo compacto no centro (CENTER_CROP corta as bordas)
  {
    file: "splash.png",
    w: 2732,
    h: 2732,
    bg: BG,
    html: `<div style="display:flex;flex-direction:column;align-items:center;gap:120px;">${tileHtml(520)}${wordmarkHtml(300)}</div>`,
    transparent: false,
  },
];

for (const s of shots) {
  const pg = await browser.newPage({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 1,
  });
  await pg.setContent(page(s.bg, s.html), { waitUntil: "networkidle" });
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(250);
  await pg.screenshot({
    path: resolve(OUT, s.file),
    omitBackground: s.transparent,
  });
  await pg.close();
  console.log(`✔ resources/${s.file} (${s.w}×${s.h})`);
}

// splash-dark = mesma arte (o app é dark-first)
const { copyFileSync } = await import("node:fs");
copyFileSync(resolve(OUT, "splash.png"), resolve(OUT, "splash-dark.png"));
console.log("✔ resources/splash-dark.png (cópia)");

await browser.close();
console.log("\nAssets da marca prontos. Agora: npm run cap:icons");
