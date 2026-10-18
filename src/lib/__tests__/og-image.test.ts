import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SOCIAL_IMAGE } from "@/lib/social-image";

// Prévia de link (WhatsApp/Telegram/iMessage): o arquivo referenciado pelo
// og:image TEM de existir em public/ (Master Release Audit, VIR-01: 404 em
// produção) e bater com as dimensões declaradas nas meta tags.
const ROOT = resolve(__dirname, "../../..");
const jpg = readFileSync(resolve(ROOT, "public", SOCIAL_IMAGE));

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

describe(`public/${SOCIAL_IMAGE}`, () => {
  it("tem a versão no nome (o WhatsApp guarda a prévia por endereço)", () => {
    expect(SOCIAL_IMAGE).toMatch(/-v\d+-1200x630\.jpg$/);
  });

  it("é um JPEG 1200×630 (proporção recomendada de Open Graph)", () => {
    expect(jpegSize(jpg)).toEqual({ width: 1200, height: 630 });
  });

  it("é leve para a prévia do WhatsApp, com folga (< 200 KB; ele descarta perto de 300)", () => {
    expect(jpg.length).toBeLessThan(200 * 1024);
  });

  it("é o arquivo que as meta tags declaram, com as mesmas dimensões", () => {
    const root = readFileSync(resolve(ROOT, "src/routes/__root.tsx"), "utf8");
    expect(root).toContain('from "@/lib/social-image"');
    expect(root).toMatch(
      /"og:image",\s*content:\s*`\$\{APP_URL\}\/\$\{SOCIAL_IMAGE\}`/,
    );
    expect(root).toMatch(
      /"twitter:image",\s*content:\s*`\$\{APP_URL\}\/\$\{SOCIAL_IMAGE\}`/,
    );
    expect(root).toMatch(/og:image:width",\s*content:\s*"1200"/);
    expect(root).toMatch(/og:image:height",\s*content:\s*"630"/);
    expect(root).toMatch(/og:image:type",\s*content:\s*"image\/jpeg"/);
  });

  it("a prévia antiga segue em public/ (links e caches que ainda apontam para ela)", () => {
    expect(existsSync(resolve(ROOT, "public/og-verbete.jpg"))).toBe(true);
  });
});
