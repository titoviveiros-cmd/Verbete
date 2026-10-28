// Ícones web/PWA a partir EXCLUSIVAMENTE do ícone aprovado da Play
// (resources/store/light-2026-10-28/icon-512.png, SHA-256 19b1b903…a5a4):
//   public/icon-512.png                 cópia byte a byte (arte original)
//   public/icon-192.png                 192×192
//   public/apple-touch-icon.png         180×180 (URL convencional do Safari)
//   public/apple-touch-icon-verbete-v1.png  180×180, nome versionado (cache)
//   public/favicon.png                  64×64
// Redimensionamento Lanczos-3 separável, em sRGB; saída RGB opaca (o
// original já é 100% opaco). Sem filtros, bordas ou fundos novos.
//   node scripts/store/gen-web-icons.mjs
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readPng, writeRgbPng } from "./png-tools.mjs";

const ROOT = process.cwd();
const SRC = resolve(ROOT, "resources/store/light-2026-10-28/icon-512.png");
const APPROVED = "19b1b903960a422059a2ba3655af61ca0d47de2f46b143c78063a1ee2e5ab5a4";
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
if (sha(SRC) !== APPROVED) throw new Error(`ícone fonte diverge do aprovado: ${sha(SRC)}`);

const src = readPng(SRC);
for (let i = 3; src.channels === 4 && i < src.px.length; i += 4)
  if (src.px[i] !== 255) throw new Error("ícone fonte não é 100% opaco");

const lanczos = (x, a = 3) => {
  if (x === 0) return 1;
  if (Math.abs(x) >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
};
// um eixo: n entradas → m saídas, com o núcleo alargado na redução
function weights(n, m) {
  const scale = n / m, support = 3 * Math.max(1, scale), out = [];
  for (let j = 0; j < m; j++) {
    const center = (j + 0.5) * scale - 0.5;
    const lo = Math.max(0, Math.floor(center - support)), hi = Math.min(n - 1, Math.ceil(center + support));
    const w = [];
    let sum = 0;
    for (let i = lo; i <= hi; i++) {
      const v = lanczos((i - center) / Math.max(1, scale));
      w.push(v);
      sum += v;
    }
    out.push({ lo, w: w.map((v) => v / sum) });
  }
  return out;
}
function resize(img, size) {
  const { width: W, height: H, channels: ch, px } = img;
  const wx = weights(W, size), wy = weights(H, size);
  const tmp = new Float64Array(H * size * 3);
  for (let y = 0; y < H; y++)
    for (let j = 0; j < size; j++) {
      const { lo, w } = wx[j];
      for (let k = 0; k < 3; k++) {
        let acc = 0;
        for (let t = 0; t < w.length; t++) acc += w[t] * px[(y * W + lo + t) * ch + k];
        tmp[(y * size + j) * 3 + k] = acc;
      }
    }
  const out = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size; i++) {
    const { lo, w } = wy[i];
    for (let j = 0; j < size; j++)
      for (let k = 0; k < 3; k++) {
        let acc = 0;
        for (let t = 0; t < w.length; t++) acc += w[t] * tmp[((lo + t) * size + j) * 3 + k];
        out[(i * size + j) * 3 + k] = Math.max(0, Math.min(255, Math.round(acc)));
      }
  }
  return { width: size, height: size, channels: 3, px: out };
}

copyFileSync(SRC, resolve(ROOT, "public/icon-512.png"));
const made = { "icon-512.png": sha(resolve(ROOT, "public/icon-512.png")) };
for (const [file, size] of [["icon-192.png", 192], ["apple-touch-icon.png", 180], ["apple-touch-icon-verbete-v1.png", 180], ["favicon.png", 64]]) {
  writeRgbPng(resolve(ROOT, "public", file), resize(src, size));
  made[file] = sha(resolve(ROOT, "public", file));
}
console.log(JSON.stringify(made, null, 1));
