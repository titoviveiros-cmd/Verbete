// Comparativo do ícone da Tela de Início do iPhone (não vai para o site):
//   node scripts/store/gen-iphone-icon-preview.mjs → resources/iphone-icon-comparativo.png
// Original 512, os PNGs gerados (180/192/64) em tamanho real e a Tela de
// Início simulada com a máscara do iOS (cantos ~22,4% do lado) a 60 pt @3x.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const uri = (f) => `data:image/png;base64,${readFileSync(resolve(ROOT, f)).toString("base64")}`;
const ICON = uri("public/apple-touch-icon-verbete-v1.png");
const cell = (label, inner) => `<div style="display:flex;flex-direction:column;align-items:center;gap:10px">${inner}<span style="font:600 15px system-ui;color:#3a2f55">${label}</span></div>`;
const app = (src, name, gray) => `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;width:92px">
  ${gray ? `<div style="width:60px;height:60px;border-radius:13.4px;background:#8e8e93;display:flex;align-items:center;justify-content:center;font:600 34px -apple-system,system-ui;color:#fff">V</div>`
    : src ? `<img src="${src}" style="width:60px;height:60px;border-radius:13.4px;display:block">`
    : `<div style="width:60px;height:60px;border-radius:13.4px;background:${name}"></div>`}
  <span style="font:500 11px -apple-system,system-ui;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.5)">${gray ? "Verbete" : src ? "Verbete" : "App"}</span></div>`;
const phone = (title, gray) => `<div style="display:flex;flex-direction:column;gap:10px;align-items:center">
  <span style="font:700 16px system-ui;color:#3a2f55">${title}</span>
  <div style="width:390px;height:330px;border-radius:44px;padding:40px 22px;background:linear-gradient(160deg,#3b6fd8,#9b5de5 55%,#f28fb4);
    display:grid;grid-template-columns:repeat(4,1fr);row-gap:22px;justify-items:center;zoom:1">
    ${app(null, "#34c759")}${app(null, "#ff9500")}${app(gray ? null : ICON, "", gray)}${app(null, "#007aff")}
    ${app(null, "#ff2d55")}${app(null, "#5856d6")}${app(null, "#ffcc00")}${app(null, "#30b0c7")}
  </div></div>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;box-sizing:border-box}body{width:1600px;height:900px;background:#efe6d6;padding:36px;font-family:system-ui}</style></head><body>
  <div style="font:800 28px system-ui;color:#241640;margin-bottom:24px">Verbete — ícone da Tela de Início (iPhone) · arte oficial da Play</div>
  <div style="display:flex;gap:36px;align-items:flex-end;margin-bottom:34px">
    ${cell("original 512×512 (aprovado)", `<img src="${uri("public/icon-512.png")}" style="width:256px;height:256px">`)}
    ${cell("apple-touch-icon 180×180 (tamanho real)", `<img src="${ICON}" style="width:180px;height:180px">`)}
    ${cell("icon-192 (tamanho real)", `<img src="${uri("public/icon-192.png")}" style="width:192px;height:192px">`)}
    ${cell("favicon 64", `<img src="${uri("public/favicon.png")}" style="width:64px;height:64px">`)}
    ${cell("máscara iOS (180 px)", `<img src="${ICON}" style="width:180px;height:180px;border-radius:40.3px">`)}
  </div>
  <div style="display:flex;gap:48px">${phone("ANTES — Safari gerava o “V” cinza (PNGs 404)", true)}${phone("DEPOIS — arte oficial", false)}</div>
</body></html>`;
const browser = await chromium.launch();
const pg = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await pg.setContent(html, { waitUntil: "load" });
await pg.screenshot({ path: resolve(ROOT, "resources/iphone-icon-comparativo.png") });
await browser.close();
console.log("ok");
