// Assets da ficha da Play Store (mesmo visual de gen-brand-assets.mjs):
//   resources/store/icon-512.png        512×512 (ícone da ficha)
//   resources/store/feature-1024x500.png feature graphic
//   public/og-verbete.jpg               1200×630 (prévia de link: WhatsApp,
//                                        Telegram, iMessage — og:image)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.cwd(), "resources", "store");
const PUBLIC = resolve(process.cwd(), "public");
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
  {
    // Prévia de link ANTIGA (até 18/10/2026): mantida em public/ para links
    // e caches que ainda apontam para ela. Não é mais a og:image.
    file: "og-verbete.jpg",
    dir: PUBLIC,
    w: 1200,
    h: 630,
    jpeg: true,
    html: `<div style="display:flex;align-items:center;gap:64px;">
      ${tileHtml(340)}
      <div style="display:flex;flex-direction:column;gap:22px;align-items:flex-start;">
        ${wordmarkHtml(140)}
        <span style="font-family:'Nunito',sans-serif;font-weight:700;font-size:36px;color:rgba(255,255,255,0.85);">Invente. Engane. Descubra a verdade.</span>
      </div>
    </div>`,
  },
  {
    // Prévia de link ATUAL (og:image / twitter:image). Nome com versão: o
    // WhatsApp guarda a prévia por endereço; arquivo novo = leitura nova.
    // Composição: a marca no QUADRADO CENTRAL (285–915 px), que é o que
    // sobra quando a prévia recorta um quadrado; cédulas, a verdade e o
    // Livro Mascote nas laterais, só na prévia larga.
    file: "verbete-social-v2-1200x630.jpg",
    dir: PUBLIC,
    w: 1200,
    h: 630,
    jpeg: true,
    quality: 86,
    html: socialHtml(),
  },
];

function ballotHtml({
  token,
  tone = "gold",
  rot,
  w = 220,
  h = 128,
  lines = [0.92, 0.78, 0.55],
}) {
  const tokenBg =
    tone === "turq"
      ? "linear-gradient(160deg,#5eead4,#2dd4bf 45%,#14b8a6)"
      : "linear-gradient(180deg,#ffe27a,#f4c542 50%,#c9971f)";
  const tokenEdge = tone === "turq" ? "#0b5e54" : "#7a5510";
  const tokenInk = tone === "turq" ? "#06221e" : "#2a1606";
  const glow =
    tone === "turq"
      ? "0 0 46px -4px rgba(45,212,191,0.75)"
      : "0 18px 36px -16px rgba(0,0,0,0.7)";
  const bars = lines
    .map(
      (f) =>
        `<div style="height:13px;width:${Math.round(f * 100)}%;border-radius:7px;background:rgba(255,255,255,${tone === "turq" ? 0.55 : 0.2});"></div>`,
    )
    .join("");
  return `<div style="width:${w}px;height:${h}px;transform:rotate(${rot}deg);border-radius:22px;padding:18px;display:flex;gap:16px;align-items:center;background:${tone === "turq" ? "linear-gradient(160deg,#2b8f87,#115e59)" : "linear-gradient(180deg,#331d68,#241546)"};border:2px solid rgba(255,255,255,${tone === "turq" ? 0.6 : 0.18});box-shadow:inset 0 1px 0 rgba(255,255,255,0.12),0 6px 0 0 ${tone === "turq" ? "#0b4a45" : "#100620"},${glow};">
    <div style="flex:none;width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Fredoka',sans-serif;font-weight:700;font-size:28px;color:${tokenInk};background:${tokenBg};border:3px solid #fff;box-shadow:0 4px 0 0 ${tokenEdge};">${token}</div>
    <div style="flex:1;display:flex;flex-direction:column;gap:11px;">${bars}</div>
  </div>`;
}

// Livro Mascote (mesmo desenho de src/components/Mascot.tsx, humor "excited",
// parado) — a prévia não anima.
function mascotSvg(size) {
  return `<svg viewBox="0 0 200 200" width="${size}" height="${size}">
    <ellipse cx="100" cy="180" rx="60" ry="8" fill="#000" opacity="0.35"/>
    <g transform="translate(20 30)">
      <rect x="0" y="0" width="160" height="120" rx="12" fill="#7B2CBF" stroke="#3A0A60" stroke-width="4"/>
      <rect x="6" y="6" width="148" height="108" rx="8" fill="#FFF6E0"/>
      <rect x="10" y="10" width="140" height="100" rx="6" fill="#FFFCEF"/>
      <rect x="76" y="0" width="8" height="120" fill="#3A0A60" opacity="0.6"/>
      <g transform="translate(80 60)">
        <circle cx="-22" cy="0" r="14" fill="#fff" stroke="#1A0936" stroke-width="3"/>
        <circle cx="-20" cy="-2" r="6" fill="#1A0936"/>
        <circle cx="22" cy="0" r="14" fill="#fff" stroke="#1A0936" stroke-width="3"/>
        <circle cx="24" cy="-2" r="6" fill="#1A0936"/>
        <path d="M -14 22 Q 0 38 14 22" stroke="#1A0936" stroke-width="3" fill="none" stroke-linecap="round"/>
        <circle cx="-30" cy="18" r="5" fill="#FF85A2" opacity="0.6"/>
        <circle cx="30" cy="18" r="5" fill="#FF85A2" opacity="0.6"/>
      </g>
    </g>
  </svg>`;
}

function sparkle(x, y, s, color) {
  return `<svg style="position:absolute;left:${x}px;top:${y}px;" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 0 C13 8 16 11 24 12 C16 13 13 16 12 24 C11 16 8 13 0 12 C8 11 11 8 12 0 Z" fill="${color}"/></svg>`;
}

function socialHtml() {
  const glyph = (ch, x, y, size, color, rot) =>
    `<span style="position:absolute;left:${x}px;top:${y}px;font-family:'Fredoka',sans-serif;font-weight:700;font-size:${size}px;color:${color};opacity:0.22;transform:rotate(${rot}deg);text-shadow:0 0 18px ${color};">${ch}</span>`;
  return `<div style="position:relative;width:1200px;height:630px;overflow:hidden;
      background:
        radial-gradient(520px 360px at 50% 40%, rgba(255,63,174,0.34), transparent 70%),
        radial-gradient(1100px 620px at 50% -14%, rgba(123,58,180,0.62), transparent 64%),
        radial-gradient(640px 420px at -4% 104%, rgba(109,40,217,0.42), transparent 70%),
        radial-gradient(560px 400px at 104% 100%, rgba(45,212,191,0.16), transparent 70%),
        #150a2c;">
    <div style="position:absolute;inset:0;background:repeating-linear-gradient(180deg,transparent 0 33px,rgba(255,255,255,0.035) 33px 34px);"></div>
    ${glyph("A", 300, 30, 54, "#f4c542", -12)}
    ${glyph("?", 860, 40, 64, "#2dd4bf", 10)}
    ${glyph("é", 250, 520, 50, "#9b6cff", 8)}
    ${glyph("!", 930, 520, 56, "#ff4f9e", -8)}
    ${glyph("Ç", 600, -6, 40, "#9b6cff", 0)}

    <div style="position:absolute;left:-26px;top:122px;">${ballotHtml({ token: "A", rot: -11 })}</div>
    <div style="position:absolute;left:28px;top:330px;">${ballotHtml({ token: "B", rot: 7, lines: [0.85, 0.62] })}</div>
    <div style="position:absolute;left:986px;top:80px;">${ballotHtml({ token: "✓", tone: "turq", rot: 9, w: 230, lines: [0.95, 0.7, 0.5] })}</div>
    <div style="position:absolute;left:968px;top:298px;">${mascotSvg(230)}</div>
    ${sparkle(948, 282, 30, "#ffe27a")}
    ${sparkle(1150, 262, 22, "#ffffff")}
    ${sparkle(1120, 520, 26, "#ff8fd0")}

    <div style="position:absolute;left:0;right:0;top:44px;display:flex;flex-direction:column;align-items:center;">
      <div style="filter:drop-shadow(0 0 40px rgba(255,63,174,0.55));">${tileHtml(196)}</div>
      <div style="margin-top:20px;">${wordmarkHtml(126)}</div>
      <span style="margin-top:22px;font-family:'Nunito',sans-serif;font-weight:800;font-size:31px;letter-spacing:0.01em;color:#f6f1ff;text-shadow:0 2px 14px rgba(0,0,0,0.45);">
        <span style="color:#f4c542;">Invente.</span> <span style="color:#ff4f9e;">Engane.</span> <span style="color:#2dd4bf;">Descubra a verdade.</span>
      </span>
      <span style="margin-top:26px;padding:10px 22px;border-radius:999px;font-family:'Nunito',sans-serif;font-weight:800;font-size:21px;color:#f6f1ff;background:rgba(255,255,255,0.08);border:1.5px solid rgba(244,197,66,0.55);box-shadow:inset 0 1px 0 rgba(255,255,255,0.12),0 3px 0 rgba(0,0,0,0.35);">
        Jogo de blefe com palavras raras · 2 a 12 jogadores
      </span>
    </div>
  </div>`;
}

// `node scripts/gen-store-assets.mjs og-verbete.jpg` gera só esse arquivo.
const only = process.argv[2];
for (const s of shots) {
  if (only && s.file !== only) continue;
  const pg = await browser.newPage({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 1,
  });
  await pg.setContent(page(s.html), { waitUntil: "networkidle" });
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(250);
  const dir = s.dir ?? OUT;
  await pg.screenshot(
    s.jpeg
      ? { path: resolve(dir, s.file), type: "jpeg", quality: s.quality ?? 88 }
      : { path: resolve(dir, s.file) },
  );
  await pg.close();
  console.log(`✔ ${s.dir ? "public" : "resources/store"}/${s.file}`);
}
await browser.close();
