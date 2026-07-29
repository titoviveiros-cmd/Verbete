// Assets da ficha da Play Store (mesmo visual de gen-brand-assets.mjs):
//   resources/store/icon-512.png        512×512 (ícone da ficha)
//   resources/store/feature-1024x500.png feature graphic
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.cwd(), "resources", "store");
mkdirSync(OUT, { recursive: true });
const BG = "#0f0a1f";
const ROXO = "#4c1a8f";

function tileHtml(size, { glow = true } = {}) {
  const s = size / 124;
  const r = Math.max(10, 28 * s);
  const border = Math.max(2, Math.round(5 * s));
  return `
  <div style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:${r}px;background:linear-gradient(135deg,#ff4bb0 0%,#c026d3 50%,#6a1fd4 100%);border:${border}px solid #fff;box-shadow:${glow ? `0 0 ${Math.round(40 * s)}px rgba(255,0,150,0.65), ` : ""}0 ${Math.round(12 * s)}px 0 rgba(76,0,128,0.35), inset 0 ${Math.max(1, Math.round(3 * s))}px 0 rgba(255,255,255,0.35);">
    <span style="font-family:'Fredoka',sans-serif;font-weight:900;line-height:1;color:#fff;font-size:${82 * s}px;margin-top:${-6 * s}px;margin-bottom:${-6 * s}px;letter-spacing:-0.05em;filter:drop-shadow(0 ${Math.max(1, Math.round(4 * s))}px 0 rgba(76,0,128,0.35));">V</span>
    <svg width="${60 * s}" height="${20 * s}" viewBox="0 0 60 20" fill="none">
      <path d="M2 16 Q15 8 29 14 L29 6 Q15 0 2 8 Z" fill="#fff"/>
      <path d="M58 16 Q45 8 31 14 L31 6 Q45 0 58 8 Z" fill="#fff"/>
      <line x1="30" y1="6" x2="30" y2="16" stroke="#fff" stroke-width="2"/>
    </svg>
  </div>`;
}

function wordmarkHtml(fontSize) {
  const s = Math.max(0.4, Math.min(1, fontSize / 80));
  const stroke = Math.max(2, Math.round(4 * s));
  return `<span style="font-family:'Fredoka',sans-serif;font-weight:900;line-height:1;font-size:${fontSize}px;color:#fff;-webkit-text-stroke:${stroke}px ${ROXO};paint-order:stroke fill;filter:drop-shadow(0 ${Math.max(3, Math.round(6 * s))}px 0 ${ROXO}) drop-shadow(0 ${Math.round(12 * s)}px ${Math.round(24 * s)}px rgba(76,26,143,0.55));letter-spacing:-0.02em;">Verbete</span>`;
}

function page(inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Nunito:wght@400;700&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:${BG};overflow:hidden}body{display:flex;align-items:center;justify-content:center}</style>
  </head><body>${inner}</body></html>`;
}

const browser = await chromium.launch();
const shots = [
  { file: "icon-512.png", w: 512, h: 512, html: tileHtml(400) },
  {
    file: "feature-1024x500.png",
    w: 1024,
    h: 500,
    html: `<div style="display:flex;align-items:center;gap:56px;">
      ${tileHtml(300)}
      <div style="display:flex;flex-direction:column;gap:18px;align-items:flex-start;">
        ${wordmarkHtml(120)}
        <span style="font-family:'Nunito',sans-serif;font-weight:700;font-size:30px;color:rgba(255,255,255,0.85);">Invente. Engane. Descubra a verdade.</span>
      </div>
    </div>`,
  },
];
for (const s of shots) {
  const pg = await browser.newPage({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 1,
  });
  await pg.setContent(page(s.html), { waitUntil: "networkidle" });
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(250);
  await pg.screenshot({ path: resolve(OUT, s.file) });
  await pg.close();
  console.log(`✔ resources/store/${s.file}`);
}
await browser.close();
