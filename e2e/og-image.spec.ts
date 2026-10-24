import { expect, test } from "@playwright/test";
import { SOCIAL_IMAGE } from "../src/lib/social-image";

// Prévia de link (WhatsApp, Telegram, iMessage). Com
// E2E_BASE_URL=https://jogo.verbete.workers.dev vira a sonda pós-deploy.

/** Largura × altura de um JPEG (marcador SOFn). */
function jpegSize(buf: Buffer): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof)
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

test("a imagem da prévia é um JPEG 1200×630 leve, servido com 200", async ({
  request,
}) => {
  const res = await request.get(`/${SOCIAL_IMAGE}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^image\/jpeg/);
  const body = await res.body();
  // O WhatsApp descarta a imagem sem aviso bem antes do limite documentado
  // (~300 kB na prática): folga de verdade, não "cabe".
  expect(body.length).toBeGreaterThan(20_000);
  expect(body.length).toBeLessThan(200_000);
  expect(body[0]).toBe(0xff);
  expect(body[1]).toBe(0xd8);
  expect(jpegSize(body)).toEqual({ w: 1200, h: 630 });
});

test("a prévia antiga continua servida (links e caches que apontam para ela)", async ({
  request,
}) => {
  const res = await request.get("/og-verbete.jpg");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^image\/jpeg/);
});

test("a home declara a prévia completa com URLs absolutas do domínio público", async ({
  request,
}) => {
  const html = await (await request.get("/")).text();
  const meta = (attr: "property" | "name", key: string) =>
    html.match(
      new RegExp(`<meta[^>]+${attr}="${key}"[^>]+content="([^"]+)"`),
    )?.[1];

  const image = meta("property", "og:image");
  expect(image).toMatch(
    new RegExp(`^https://[^/]+/${SOCIAL_IMAGE.replace(/\./g, "\\.")}$`),
  );
  expect(image).not.toMatch(/localhost|verbete\.app\//);
  expect(meta("property", "og:image:secure_url")).toBe(image);
  expect(meta("name", "twitter:image")).toBe(image);
  expect(meta("property", "og:image:type")).toBe("image/jpeg");
  expect(meta("property", "og:image:width")).toBe("1200");
  expect(meta("property", "og:image:height")).toBe("630");
  expect(meta("property", "og:image:alt")?.length ?? 0).toBeGreaterThan(20);
  expect(meta("name", "twitter:card")).toBe("summary_large_image");
  // título exato da prévia (dois-pontos, não travessão — 2.1.1)
  expect(meta("property", "og:title")).toBe(
    "Verbete: blefe com palavras raras",
  );
  expect(meta("name", "twitter:title")).toBe(
    "Verbete: blefe com palavras raras",
  );
  expect(meta("property", "og:description")?.length ?? 0).toBeGreaterThan(40);
  expect(meta("property", "og:url")).toMatch(/^https:\/\/[^/]+\/$/);
  expect(meta("property", "og:locale")).toBe("pt_BR");
  expect(html).toMatch(
    /<link[^>]+rel="canonical"[^>]+href="https:\/\/[^"]+\/"/,
  );
});
