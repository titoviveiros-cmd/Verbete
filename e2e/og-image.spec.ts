import { expect, test } from "@playwright/test";

// Prévia de link: a imagem do og:image responde 200 como JPEG. Com
// E2E_BASE_URL=https://jogo.verbete.workers.dev vira a sonda pós-deploy.
test("og:image é servida como JPEG", async ({ request }) => {
  const res = await request.get("/og-verbete.jpg");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^image\/jpeg/);
  const body = await res.body();
  expect(body.length).toBeGreaterThan(10_000);
  expect(body[0]).toBe(0xff);
  expect(body[1]).toBe(0xd8);
});

test("a home declara a og:image apontando para o domínio público", async ({
  request,
}) => {
  const html = await (await request.get("/")).text();
  const og = html.match(
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/,
  )?.[1];
  expect(og).toMatch(/^https:\/\/[^/]+\/og-verbete\.jpg$/);
  expect(og).not.toMatch(/localhost|verbete\.app\//);
});
