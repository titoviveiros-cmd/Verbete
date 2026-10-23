// Simulação da prévia de link no WhatsApp (tema escuro do app), para conferir
// a arte social em miniatura ANTES de publicar: cartão grande (imagem
// 1,91:1 no topo do balão) e cartão pequeno (quadrado recortado do centro).
// É uma aproximação do layout do WhatsApp — o teste definitivo é colar o
// link num chat real (passo a passo em docs/collection-alignment-verbete.md).
//
//   node scripts/social-preview-sim.mjs public/og-verbete.jpg public/verbete-social-v2-1200x630.jpg
//   → resources/social-preview-sim.png (uma coluna por imagem)
// Cada argumento pode trazer o próprio título e descrição (antes × depois):
//   "public/og-verbete.jpg::Título antigo::Descrição antiga"
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";

const images = process.argv.slice(2);
if (images.length === 0) {
  console.error(
    "uso: node scripts/social-preview-sim.mjs <imagem> [<imagem> ...]",
  );
  process.exit(1);
}
const OUT = resolve(process.cwd(), "resources", "social-preview-sim.png");
mkdirSync(resolve(process.cwd(), "resources"), { recursive: true });

const TITLE = "Verbete — blefe com palavras raras";
const DESC =
  "Invente significados, engane os amigos e descubra a verdade. De 4 a 12 jogadores.";
const HOST = "jogo.verbete.workers.dev";

const dataUri = (p) =>
  `data:image/jpeg;base64,${readFileSync(resolve(process.cwd(), p)).toString("base64")}`;

const column = (arg) => {
  const [p, title = TITLE, desc = DESC] = arg.split("::");
  return `
  <section class="col">
    <p class="label">${basename(p)}</p>
    <div class="chat">
      <div class="bubble">
        <div class="card">
          <img class="big" src="${dataUri(p)}" alt="">
          <div class="meta"><b>${title}</b><span>${desc}</span><i>${HOST}</i></div>
        </div>
        <p class="txt"><a>https://${HOST}/</a></p>
        <p class="time">13:05 ✓✓</p>
      </div>
      <div class="bubble">
        <div class="card row">
          <div class="thumb" style="background-image:url('${dataUri(p)}')"></div>
          <div class="meta"><b>${title}</b><span>${desc}</span><i>${HOST}</i></div>
        </div>
        <p class="txt">bora jogar hoje? <a>https://${HOST}/?v=2</a></p>
        <p class="time">13:06 ✓✓</p>
      </div>
    </div>
  </section>`;
};

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#111b21;font-family:Roboto,"Segoe UI",Arial,sans-serif;padding:20px;display:flex;gap:28px}
  .col{width:380px}
  .label{color:#8696a0;font-size:13px;margin:0 0 10px 6px}
  .chat{background:#0b141a;border-radius:18px;padding:18px 12px;display:flex;flex-direction:column;gap:14px;align-items:flex-end}
  .bubble{background:#005c4b;border-radius:10px;padding:4px;max-width:318px;color:#e9edef}
  .card{background:#025144;border-radius:7px;overflow:hidden}
  .card.row{display:flex;gap:0}
  .big{display:block;width:310px;height:162px;object-fit:cover}
  .thumb{flex:none;width:88px;height:88px;background-size:cover;background-position:center}
  .meta{padding:8px 10px;display:flex;flex-direction:column;gap:3px;min-width:0}
  .meta b{font-size:14px;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .meta span{font-size:12.5px;color:#aebac1;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .meta i{font-style:normal;font-size:12px;color:#8696a0}
  .txt{font-size:14.2px;padding:6px 6px 0}
  .txt a{color:#53bdeb;text-decoration:underline}
  .time{font-size:11px;color:#a5c4bd;text-align:right;padding:2px 6px 2px}
</style></head><body>${images.map(column).join("")}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 40 + images.length * 408, height: 600 },
  deviceScaleFactor: 2,
});
await page.setContent(html, { waitUntil: "load" });
const h = await page.evaluate(() => document.body.scrollHeight);
await page.setViewportSize({ width: 40 + images.length * 408, height: h });
await page.screenshot({ path: OUT });
await browser.close();
console.log(`✔ ${OUT}`);
