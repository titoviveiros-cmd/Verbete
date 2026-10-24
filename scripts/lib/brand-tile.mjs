// Desenho oficial da marca (VerbeteTile e wordmark) em HTML, para os scripts
// que renderizam assets via Chromium headless — fiel a src/components/
// VerbeteLogo.tsx (proporções derivadas do tile original de 124 px).
const ROXO = "#4c1a8f";

// Tile fiel ao VerbeteTile.tsx.
export function tileHtml(size, { glow = true } = {}) {
  const s = size / 124;
  const r = Math.max(10, 28 * s);
  const border = Math.max(2, Math.round(5 * s));
  return `
  <div style="
    position:relative; display:flex; flex-direction:column; align-items:center;
    justify-content:center; width:${size}px; height:${size}px;
    border-radius:${r}px;
    background:linear-gradient(135deg, #ff4bb0 0%, #c026d3 50%, #6a1fd4 100%);
    border:${border}px solid #ffffff;
    box-shadow:${glow ? `0 0 ${Math.round(40 * s)}px rgba(255,0,150,0.65), ` : ""}0 ${Math.round(12 * s)}px 0 rgba(76,0,128,0.35), inset 0 ${Math.max(1, Math.round(3 * s))}px 0 rgba(255,255,255,0.35);
  ">
    ${glyphInner(s, { shadow: true })}
  </div>`;
}

// Só o "V" e o livro do tile (mesma posição), sem o quadrado — base do ícone
// monocromático (temático) do Android.
export function glyphHtml(size) {
  const s = size / 124;
  return `
  <div style="
    display:flex; flex-direction:column; align-items:center;
    justify-content:center; width:${size}px; height:${size}px;
  ">
    ${glyphInner(s, { shadow: false })}
  </div>`;
}

function glyphInner(s, { shadow }) {
  return `
    <span style="
      font-family:'Fredoka',sans-serif; font-weight:900; line-height:1;
      color:#ffffff; font-size:${82 * s}px; margin-top:${-6 * s}px;
      margin-bottom:${-6 * s}px; letter-spacing:-0.05em;
      ${shadow ? `filter:drop-shadow(0 ${Math.max(1, Math.round(4 * s))}px 0 rgba(76,0,128,0.35));` : ""}
    ">V</span>
    <svg width="${60 * s}" height="${20 * s}" viewBox="0 0 60 20" fill="none">
      <path d="M2 16 Q15 8 29 14 L29 6 Q15 0 2 8 Z" fill="#ffffff"/>
      <path d="M58 16 Q45 8 31 14 L31 6 Q45 0 58 8 Z" fill="#ffffff"/>
      <line x1="30" y1="6" x2="30" y2="16" stroke="#ffffff" stroke-width="2"/>
    </svg>`;
}

// Wordmark fiel ao verbeteWordmarkStyle (branco, contorno e sombra roxos).
export function wordmarkHtml(fontSize) {
  const s = Math.max(0.4, Math.min(1, fontSize / 80));
  const stroke = Math.max(2, Math.round(4 * s));
  return `
  <span style="
    font-family:'Fredoka',sans-serif; font-weight:900; line-height:1;
    font-size:${fontSize}px; color:#ffffff;
    -webkit-text-stroke:${stroke}px ${ROXO}; paint-order:stroke fill;
    filter:drop-shadow(0 ${Math.max(3, Math.round(6 * s))}px 0 ${ROXO}) drop-shadow(0 ${Math.round(12 * s)}px ${Math.round(24 * s)}px rgba(76,26,143,0.55));
    letter-spacing:-0.02em;
  ">Verbete</span>`;
}

export function page(bodyBg, inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:100%; height:100%; background:${bodyBg}; overflow:hidden; }
    body { display:flex; align-items:center; justify-content:center; }
    /* Fredoka não tem 900 — o navegador sintetiza a partir do 700, igual ao app */
  </style></head><body>${inner}</body></html>`;
}
