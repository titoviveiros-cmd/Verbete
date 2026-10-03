import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Prévia de link (WhatsApp/Telegram/iMessage): o arquivo referenciado pelo
// og:image TEM de existir em public/ (Master Release Audit, VIR-01: 404 em
// produção) e bater com as dimensões declaradas nas meta tags.
const ROOT = resolve(__dirname, "../../..");
const jpg = readFileSync(resolve(ROOT, "public/og-verbete.jpg"));

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      return {
        height: buf.readUInt16BE(i + 5),
        width: buf.readUInt16BE(i + 7),
      };
    }
    i += 2 + len;
  }
  return null;
}

describe("public/og-verbete.jpg", () => {
  it("é um JPEG 1200×630 (proporção recomendada de Open Graph)", () => {
    expect(jpegSize(jpg)).toEqual({ width: 1200, height: 630 });
  });

  it("é leve o bastante para a prévia do WhatsApp (< 300 KB)", () => {
    expect(jpg.length).toBeLessThan(300 * 1024);
  });

  it("é o arquivo que as meta tags declaram, com as mesmas dimensões", () => {
    const root = readFileSync(resolve(ROOT, "src/routes/__root.tsx"), "utf8");
    expect(root).toContain("/og-verbete.jpg");
    expect(root).toMatch(/og:image:width",\s*content:\s*"1200"/);
    expect(root).toMatch(/og:image:height",\s*content:\s*"630"/);
    expect(root).toMatch(/og:image:type",\s*content:\s*"image\/jpeg"/);
  });
});
