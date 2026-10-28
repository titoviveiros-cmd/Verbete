// Prévia de link (og:image) TEMA CLARO — public/verbete-social-v3-1200x630.jpg
//   node scripts/store/gen-social-v3.mjs
// Duas propostas (P1 empilhada no centro, P2 horizontal); a escolhida é a que
// mantém símbolo + marca + frase inteiros no quadrado central 630×630 (o
// recorte da miniatura do WhatsApp). Mesmo visual da ficha da Play de
// 28/10/2026 (scripts/store/gen-store-light.mjs). A v2 escura fica em public/.
import { chromium } from "playwright";
import { mkdirSync, statSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const WORK = resolve(ROOT, "resources/store/light-2026-10-28/_work");
mkdirSync(WORK, { recursive: true });
const C = { creme: "#fbf3e3", cartao: "#fffaf0", tinta: "#241640", magenta: "#d61f74", roxo: "#6d28d9", violeta: "#9b6cff", turquesa: "#0b7166", turqClaro: "#2dd4bf", ouro: "#f4c542", ouroTopo: "#ffe27a", rosa: "#ff4fa8" };
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&family=Nunito:wght@700;800&display=swap" rel="stylesheet">`;
const page = (body) => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:1200px;height:630px;overflow:hidden;background:${C.creme}}body{position:relative}</style></head><body>
<div style="position:absolute;inset:0;background:radial-gradient(34% 60% at 50% 30%,rgba(255,79,168,.18),transparent 70%),radial-gradient(30% 55% at 12% 80%,rgba(155,108,255,.16),transparent 70%),radial-gradient(30% 55% at 90% 20%,rgba(45,212,191,.14),transparent 70%),${C.creme}"></div>${body}</body></html>`;
const mascot = (size) => `<svg viewBox="0 0 200 200" width="${size}" height="${size}"><ellipse cx="100" cy="182" rx="58" ry="8" fill="#3a0a60" opacity=".18"/><g transform="translate(20 30)"><rect width="160" height="120" rx="12" fill="#7B2CBF" stroke="#3A0A60" stroke-width="4"/><rect x="6" y="6" width="148" height="108" rx="8" fill="#FFF6E0"/><rect x="10" y="10" width="140" height="100" rx="6" fill="#FFFCEF"/><rect x="76" width="8" height="120" fill="#3A0A60" opacity=".6"/><g transform="translate(80 60)"><circle cx="-22" r="14" fill="#fff" stroke="#1A0936" stroke-width="3"/><circle cx="-20" cy="-2" r="6" fill="#1A0936"/><circle cx="22" r="14" fill="#fff" stroke="#1A0936" stroke-width="3"/><circle cx="24" cy="-2" r="6" fill="#1A0936"/><path d="M -14 22 Q 0 38 14 22" stroke="#1A0936" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="-30" cy="18" r="5" fill="#FF85A2" opacity=".6"/><circle cx="30" cy="18" r="5" fill="#FF85A2" opacity=".6"/></g></g></svg>`;
const sparkle = (x, y, s, c) => `<svg style="position:absolute;left:${x}px;top:${y}px" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 0 C13 8 16 11 24 12 C16 13 13 16 12 24 C11 16 8 13 0 12 C8 11 11 8 12 0 Z" fill="${c}"/></svg>`;
function tile(size) {
  const s = size / 124;
  return `<div style="position:relative;width:${size}px;height:${size}px;border-radius:${28 * s}px;background:linear-gradient(140deg,${C.rosa} 0%,#d22bc9 48%,#6a1fd4 100%);border:${Math.round(5 * s)}px solid #fff;box-shadow:0 ${10 * s}px 0 rgba(84,20,140,.28),0 ${18 * s}px ${30 * s}px rgba(168,40,160,.30),inset 0 ${3 * s}px 0 rgba(255,255,255,.38),inset 0 -${6 * s}px ${14 * s}px rgba(60,0,120,.25);display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden">
  <div style="position:absolute;inset:0;background:radial-gradient(120% 70% at 20% 0%,rgba(255,255,255,.28),transparent 55%)"></div>
  <span style="position:relative;font:700 ${86 * s}px/1 'Fredoka';color:#fff;margin:${-8 * s}px 0;filter:drop-shadow(0 ${4 * s}px 0 rgba(76,0,128,.35))">V</span>
  <svg style="position:relative" width="${62 * s}" height="${21 * s}" viewBox="0 0 60 20" fill="none"><path d="M2 16 Q15 8 29 14 L29 6 Q15 0 2 8 Z" fill="#fff"/><path d="M58 16 Q45 8 31 14 L31 6 Q45 0 58 8 Z" fill="#fff"/><line x1="30" y1="6" x2="30" y2="16" stroke="#fff" stroke-width="2"/></svg></div>`;
}
const word = (px) => `<span style="font:700 ${px}px/1 'Fredoka';color:#fff;-webkit-text-stroke:${Math.round(px / 20)}px #4c1a8f;paint-order:stroke fill;letter-spacing:-.02em;filter:drop-shadow(0 ${Math.round(px / 17)}px 0 #4c1a8f) drop-shadow(0 ${Math.round(px / 9)}px ${Math.round(px / 6)}px rgba(76,26,143,.28))">Verbete</span>`;
const ballot = (x, y, rot, l, t, truth) => `<div style="position:absolute;left:${x}px;top:${y}px;width:230px;transform:rotate(${rot}deg);background:${C.cartao};border:3px solid #eadcf6;border-radius:20px;padding:13px 15px;display:flex;gap:11px;align-items:center;box-shadow:0 7px 0 #e6d3c2,0 12px 24px rgba(80,40,120,.15)"><span style="flex:none;width:38px;height:38px;border-radius:50%;background:linear-gradient(180deg,#a678ff,${C.roxo});color:#fff;font:700 21px 'Fredoka';display:flex;align-items:center;justify-content:center;box-shadow:0 3px 0 #3d1580">${l}</span><span style="font:800 16px/1.2 'Nunito';color:${C.tinta}">${t}</span>${truth ? `<span style="position:absolute;right:-12px;top:-15px;transform:rotate(8deg);background:linear-gradient(180deg,${C.ouroTopo},${C.ouro});color:#3a2400;font:700 14px 'Fredoka';padding:5px 11px;border-radius:999px;box-shadow:0 3px 0 #b8860b">✓ VERDADE</span>` : ""}</div>`;
const tagline = (px, br) => `<span style="font:800 ${px}px/1.22 'Nunito';color:${C.tinta};text-align:center"><span style="color:${C.magenta}">Invente.</span> <span style="color:${C.roxo}">Engane.</span>${br ? "<br>" : " "}<span style="color:${C.turquesa}">Descubra a verdade.</span></span>`;

// P1: tudo essencial empilhado no quadrado central (x 285–915)
const P1 = page(`
  ${ballot(46, 120, -7, "A", "doce de rapadura ralada", false)}
  ${ballot(40, 400, 5, "C", "tambor de couro do sertão", false)}
  ${ballot(930, 410, -5, "B", "cumprimento cheio de mesuras", true)}
  ${sparkle(940, 110, 40, C.ouro)}${sparkle(230, 520, 26, C.turqClaro)}${sparkle(1110, 300, 22, C.violeta)}
  <div style="position:absolute;left:0;right:0;top:34px;display:flex;justify-content:center"><div style="position:relative">${tile(200)}
    <div style="position:absolute;left:168px;top:96px">${mascot(132)}</div></div></div>
  <div style="position:absolute;left:0;right:0;top:268px;display:flex;justify-content:center">${word(128)}</div>
  <div style="position:absolute;left:0;right:0;top:438px;display:flex;justify-content:center">${tagline(36, true)}</div>`);
// P2: horizontal (como o gráfico de recursos da Play)
const P2 = page(`
  <div style="position:absolute;left:120px;top:150px">${tile(280)}</div>
  <div style="position:absolute;left:345px;top:330px">${mascot(160)}</div>
  ${sparkle(372, 128, 44, C.ouro)}
  <div style="position:absolute;left:560px;top:150px;display:flex;flex-direction:column;gap:18px">${word(136)}${tagline(36, true).replace("text-align:center", "text-align:left")}</div>
  ${ballot(840, 470, -4, "B", "cumprimento cheio de mesuras", true)}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const pg = await ctx.newPage();
for (const [n, html] of [["P1", P1], ["P2", P2]]) {
  await pg.setContent(html, { waitUntil: "networkidle" });
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: `${WORK}/social-${n}.jpg`, type: "jpeg", quality: 88 });
  // recorte quadrado central (miniatura do WhatsApp) para a comparação
  await pg.screenshot({ path: `${WORK}/social-${n}-quadrado.png`, clip: { x: 285, y: 0, width: 630, height: 630 } });
  console.log(n, statSync(`${WORK}/social-${n}.jpg`).size, "bytes");
}
await browser.close();
const pick = process.argv[2] ?? "P1";
copyFileSync(`${WORK}/social-${pick}.jpg`, resolve(ROOT, "public/verbete-social-v3-1200x630.jpg"));
console.log("escolhida:", pick);
