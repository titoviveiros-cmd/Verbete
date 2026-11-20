// Utilitário mínimo de PNG (sem dependências): lê PNG 8 bits RGB/RGBA não
// entrelaçado (o que o Chromium gera), reescreve sem alpha (RGB 24 bits) e
// mede o que a Play Store exige — dimensões, tipo de cor, transparência.
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function readPng(file) {
  const buf = readFileSync(file);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error(`${file}: não é PNG`);
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType))
    throw new Error(`${file}: formato não suportado (${bitDepth}/${colorType}/${interlace})`);
  const ch = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
  }
  return { width, height, colorType, channels: ch, px, bytes: buf.length };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Grava RGB 24 bits (sem alpha). Pixels RGBA são compostos sobre `bg`. */
export function writeRgbPng(file, img, bg = [0xfb, 0xf3, 0xe3]) {
  const { width, height, channels, px } = img;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const al = channels === 4 ? px[i + 3] / 255 : 1;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(px[i + k] * al + bg[k] * (1 - al));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

/** Grava RGBA 32 bits (o ícone da Play pede PNG 32 bits com canal alpha). */
export function writeRgbaPng(file, img) {
  const { width, height, channels, px } = img;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = px[i];
      raw[o + 1] = px[i + 1];
      raw[o + 2] = px[i + 2];
      raw[o + 3] = channels === 4 ? px[i + 3] : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(file, Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

/** Métricas para a validação: transparência e luminância média (tema claro). */
export function stats(img) {
  const { width, height, channels, px } = img;
  let transparent = 0, lum = 0, light = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    if (channels === 4 && px[o + 3] < 255) transparent++;
    const l = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    lum += l;
    if (l > 200) light++;
  }
  return { transparentPx: transparent, meanLum: Math.round(lum / n), lightShare: +(light / n).toFixed(3) };
}
