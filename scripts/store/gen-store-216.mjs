// Ficha Google Play 2.1.6 (20/11/2026): moldura creme com legenda — o MESMO layout
// das coleções de 28/10 e 11/11 (gen-store-sem-ia.mjs) — sobre as capturas reais.
//   1) npx playwright test -c scripts/store/playwright.store-216.config.ts   (→ _raw/)
//   2) PACOTE=<pasta GOOGLE-PLAY-FINAL-2.1.6> PREV=<pasta da coleção 11/11> node scripts/store/gen-store-216.mjs
// Ícone e gráfico de recursos: COPIADOS sem alteração da coleção de 11/11 (= 28/10).
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readPng, stats, writeRgbPng } from "./png-tools.mjs";
import { fontFaceCss } from "./local-fonts.mjs";

const ROOT = process.cwd();
const RAW = resolve(ROOT, "resources/store/play-2.1.6/_raw");
const WORK = resolve(ROOT, "resources/store/play-2.1.6/_work");
const PACOTE = process.env.PACOTE;
const PREV = process.env.PREV;
if (!PACOTE || !PREV) throw new Error("defina PACOTE e PREV");
for (const d of [WORK, `${PACOTE}/screenshots`, `${PACOTE}/icone`, `${PACOTE}/arte-destaque`, `${PACOTE}/alternativas`])
  mkdirSync(d, { recursive: true });

const C = {
  creme: "#fbf3e3", tinta: "#241640", tintaSuave: "#5b4b7d", magenta: "#d61f74",
  roxo: "#6d28d9", turquesa: "#0b7166", ouro: "#b07d0e",
};
// Fontes LOCAIS embutidas (data:), sem Google Fonts — ver local-fonts.mjs (21/11/2026).
const FONTS = `<style>${fontFaceCss()}</style>`;
const page = (w, h, body, bg = C.creme) => `<!doctype html><html><head><meta charset="utf-8">${FONTS}
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${w}px;height:${h}px;overflow:hidden;background:${bg}}
body{position:relative;font-family:'Nunito',sans-serif}</style></head><body>${body}</body></html>`;

// [arquivo final, captura bruta, título, subtítulo, cor do destaque]
const SHOTS = [
  ["01-blefe", "01-blefe", "Invente uma <b>definição</b>", "Convença a mesa de que é a verdade", C.roxo],
  ["02-votacao", "02-votacao", "Qual é a <b>verdadeira</b>?", "Vote na definição certa e fuja dos blefes", C.magenta],
  ["03-diario", "03-diario", "Desafio <b>Diário</b>", "Uma palavra rara e quatro alternativas", C.turquesa],
  ["04-home", "04-home", "O jogo do <b>blefe</b> com palavras", "Conta opcional · 4 a 12 jogadores", C.magenta],
  ["05-multiplayer", "05-multiplayer", "Jogue com a <b>galera</b>", "De 4 a 12 jogadores, com bots se faltar gente", C.roxo],
  ["06-revelacao", "06-revelacao", "A verdade <b>aparece</b>", "Veja quem acertou e quem caiu no seu blefe", C.turquesa],
  ["07-placar", "07-placar", "Quem engana <b>mais</b> vence", "Pontos por acertar e por enganar", C.ouro],
  ["08-conquistas", "08-conquistas", "Colecione <b>conquistas</b>", "Toque em uma para ver como desbloquear", C.magenta],
];
const ALTS = [
  ["01-blefe-enviada", "alt-01-blefe-enviada", "Invente uma <b>definição</b>", "Convença a mesa de que é a verdade", C.roxo],
  ["07-placar-rodada", "alt-07-placar-rodada", "Quem engana <b>mais</b> vence", "Pontos por acertar e por enganar", C.ouro],
  ["08-perfil-topo", "alt-08-perfil-topo", "Suba de <b>nível</b>", "XP e estatísticas no seu perfil", C.magenta],
];

function shotHtml(title, sub, accent, dataUri) {
  const W = 906, H = 1611, top = 268;
  return page(1080, 1920, `
    <div style="position:absolute;inset:0;background:radial-gradient(60% 30% at 50% 0%,rgba(255,79,168,.16),transparent 70%),radial-gradient(70% 40% at 50% 100%,rgba(155,108,255,.14),transparent 70%),${C.creme}"></div>
    <div style="position:absolute;left:0;right:0;top:54px;text-align:center;padding:0 60px">
      <div style="font:700 66px/1.08 'Fredoka';color:${C.tinta};letter-spacing:-.01em">${title.replace("<b>", `<b style="color:${accent};font-weight:700">`)}</div>
      <div style="font:800 34px/1.3 'Nunito';color:${C.tintaSuave};margin-top:14px">${sub}</div>
    </div>
    <div style="position:absolute;left:${(1080 - W) / 2}px;top:${top}px;width:${W}px;height:${H}px;border-radius:48px;overflow:hidden;
      box-shadow:0 0 0 6px #fff, 0 0 0 9px #ead7f3, 0 26px 50px rgba(70,30,110,.22)">
      <img src="${dataUri}" style="width:${W}px;height:${H}px;display:block"></div>`);
}

const browser = await chromium.launch();
async function render(html, w, h, file) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  // Trava de rede: a página só usa data: (capturas e fontes embutidas). Qualquer http(s) = erro.
  const externos = [];
  await ctx.route("**/*", (r) => (externos.push(r.request().url().slice(0, 80)), r.abort()));
  const pg = await ctx.newPage();
  await pg.setContent(html, { waitUntil: "networkidle" });
  await pg.evaluate(() => document.fonts.ready);
  const fontes = await pg.evaluate(() =>
    ["Fredoka", "Nunito"].map((fam) =>
      [...document.fonts].some((f) => f.family.replace(/['"]/g, "") === fam && f.status === "loaded"),
    ),
  );
  if (!fontes.every(Boolean)) throw new Error(`fontes locais da legenda não carregaram: ${fontes}`);
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: file });
  await ctx.close();
  if (externos.length) throw new Error(`requisição externa na renderização: ${externos}`);
}
const uri = (f) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;

for (const [out, raw, t, s, a] of SHOTS) {
  await render(shotHtml(t, s, a, uri(`${RAW}/${raw}.png`)), 1080, 1920, `${WORK}/${out}.png`);
  writeRgbPng(`${PACOTE}/screenshots/${out}.png`, readPng(`${WORK}/${out}.png`));
}
for (const [out, raw, t, s, a] of ALTS) {
  await render(shotHtml(t, s, a, uri(`${RAW}/${raw}.png`)), 1080, 1920, `${WORK}/alt-${out}.png`);
  writeRgbPng(`${PACOTE}/alternativas/${out}.png`, readPng(`${WORK}/alt-${out}.png`));
}

copyFileSync(resolve(PREV, "icon-512.png"), `${PACOTE}/icone/icon-512.png`);
copyFileSync(resolve(PREV, "feature-1024x500.png"), `${PACOTE}/arte-destaque/feature-1024x500.png`);

// Prancha única: as 8 capturas numeradas, na ordem de publicação (só conferência; não enviar).
const tw = 420, th = 747;
const visao = page(4 * tw + 5 * 36, 140 + 2 * (th + 84) + 20, `
  <div style="padding:36px 36px 0;font:700 46px 'Fredoka';color:${C.tinta}">Verbete 2.1.6 — capturas Google Play, na ordem de publicação
    <span style="font:800 24px 'Nunito';color:${C.tintaSuave};margin-left:16px">1080×1920 · telas reais · dados fictícios</span></div>
  <div style="display:grid;grid-template-columns:repeat(4,${tw}px);gap:84px 36px;padding:44px 36px 0">
    ${SHOTS.map(([out], i) => `<div style="position:relative">
      <img src="${uri(`${PACOTE}/screenshots/${out}.png`)}" style="width:${tw}px;height:${th}px;border-radius:18px;box-shadow:0 8px 22px rgba(0,0,0,.16);display:block">
      <div style="position:absolute;left:-14px;top:-18px;width:64px;height:64px;border-radius:50%;background:${C.roxo};color:#fff;font:700 34px 'Fredoka';display:flex;align-items:center;justify-content:center;box-shadow:0 4px 0 #3d1580">${i + 1}</div>
      <div style="text-align:center;margin-top:12px;font:800 26px 'Nunito';color:${C.tinta}">${out}.png</div></div>`).join("")}
  </div>`, "#efe6d6");
await render(visao, 4 * tw + 5 * 36, 140 + 2 * (th + 84) + 20, `${WORK}/visao.png`);
writeRgbPng(`${PACOTE}/VISAO-GERAL.png`, readPng(`${WORK}/visao.png`));
await browser.close();

// Manifesto: SHA-256, resolução, tamanho, tipo de cor e origem de cada arquivo.
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const ORIGEM = {
  screenshots: "captura real do app (master 4e08219 = 2.1.6/vc10; Playwright 432×768 @2,5, tema claro, Supabase e server functions simulados, dados fictícios) em moldura creme com legenda (scripts/store/gen-store-216.mjs)",
  alternativas: "alternativa opcional (mesmo método); NÃO faz parte do conjunto principal",
  icone: `cópia sem alteração de ${PREV}\\icon-512.png (coleção 11/11 = 28/10)`,
  "arte-destaque": `cópia sem alteração de ${PREV}\\feature-1024x500.png (coleção 11/11 = 28/10)`,
};
const arquivos = [
  ...SHOTS.map(([o]) => `screenshots/${o}.png`),
  "icone/icon-512.png",
  "arte-destaque/feature-1024x500.png",
  "VISAO-GERAL.png",
  ...ALTS.map(([o]) => `alternativas/${o}.png`),
];
const manifesto = { gerado_em: new Date().toISOString(), versao: "2.1.6 (10)", commit_app: "4e08219201a75469a3c8d81b7fdbb86363b39243", arquivos: [] };
for (const f of arquivos) {
  const p = `${PACOTE}/${f}`;
  const img = readPng(p);
  manifesto.arquivos.push({
    arquivo: f,
    sha256: sha(p),
    resolucao: `${img.width}x${img.height}`,
    bytes: statSync(p).size,
    cor: img.colorType === 6 ? "RGBA 32 bits" : img.colorType === 2 ? "RGB 24 bits (sem alfa)" : `tipo ${img.colorType}`,
    ...stats(img),
    origem: f === "VISAO-GERAL.png" ? "prancha de conferência (NÃO enviar à Play)" : ORIGEM[f.split("/")[0]],
  });
}
for (const t of ["descricao-curta.txt", "descricao-completa.txt"]) {
  const s = readFileSync(`${PACOTE}/${t}`, "utf8");
  manifesto.arquivos.push({ arquivo: t, sha256: sha(`${PACOTE}/${t}`), caracteres: [...s].length, bytes: statSync(`${PACOTE}/${t}`).size, origem: "texto revisado contra o código da master 4e08219" });
}
writeFileSync(`${PACOTE}/MANIFESTO-ARQUIVOS.json`, JSON.stringify(manifesto, null, 2));
console.log(JSON.stringify(manifesto.arquivos.map((a) => [a.arquivo, a.resolucao ?? a.caracteres, a.bytes, a.cor ?? ""]), null, 0));
