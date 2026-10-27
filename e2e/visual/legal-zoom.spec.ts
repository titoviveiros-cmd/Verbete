// Zoom nas páginas de leitura (Rodada 2B, 2026-10-27): Política, Termos,
// Suporte e Excluir conta ampliam com a pinça; ao voltar para o jogo a
// escala fixa (zoom.spec.ts) volta inteira — meta viewport da raiz, sem o
// atributo do <html> e escala 1. Mesmo método do zoom.spec.ts: Chromium em
// modo celular e dedos reais pelo CDP (Input.dispatchTouchEvent).
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { homeBackend } from "./fixtures";
import {
  PAGE_ZOOM_ATTR,
  READING_VIEWPORT_CONTENT,
  VIEWPORT_CONTENT,
} from "../../src/lib/viewport";

test.use({
  viewport: { width: 360, height: 800 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

const scale = (page: Page) =>
  page.evaluate(() => window.visualViewport?.scale ?? 1);
const meta = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('meta[name="viewport"]')].map(
      (m) => m.getAttribute("content") ?? "",
    ),
  );
const zoomAttr = (page: Page) =>
  page.evaluate(
    (a) => document.documentElement.hasAttribute(a),
    PAGE_ZOOM_ATTR,
  );

async function pinch(cdp: CDPSession, cx: number, cy: number) {
  const steps = 12;
  const at = (k: number) => [
    { id: 0, x: cx - 30 - (100 * k) / steps, y: cy },
    { id: 1, x: cx + 30 + (100 * k) / steps, y: cy },
  ];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: at(0),
  });
  for (let k = 1; k <= steps; k++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: at(k),
    });
    await new Promise((r) => setTimeout(r, 16));
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

async function openReading(page: Page, path: string, h1: RegExp) {
  await installSupabaseMock(page, homeBackend(false));
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible({
    timeout: 25_000,
  });
  await page.waitForTimeout(800);
  return page.context().newCDPSession(page);
}

for (const { path, h1 } of [
  { path: "/privacy", h1: /Política de Privacidade/ },
  { path: "/terms", h1: /Termos de Uso/ },
  { path: "/support", h1: /Suporte/ },
  { path: "/delete-account", h1: /Excluir conta/ },
]) {
  test(`${path}: a pinça amplia o texto`, async ({ page }) => {
    test.setTimeout(60_000);
    const cdp = await openReading(page, path, h1);
    expect(await meta(page)).toEqual([READING_VIEWPORT_CONTENT]);
    expect(await zoomAttr(page)).toBe(true);
    expect(await scale(page)).toBe(1);
    await pinch(cdp, 180, 420);
    await page.waitForTimeout(400);
    expect(await scale(page), "pinça não ampliou").toBeGreaterThan(1.2);
  });
}

test("voltar da Política para o jogo restaura a escala fixa", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const cdp = await openReading(page, "/privacy", /Política de Privacidade/);
  await pinch(cdp, 180, 420);
  await page.waitForTimeout(400);
  expect(await scale(page)).toBeGreaterThan(1.2);

  // navegação no app (sem recarregar): o link "voltar" da página
  await page.evaluate(() => {
    (document.querySelector('header a[href="/"]') as HTMLElement).click();
  });
  await expect(page).toHaveURL(/\/$/);
  await expect
    .poll(() => meta(page), { timeout: 10_000 })
    .toEqual([VIEWPORT_CONTENT]);
  expect(await zoomAttr(page)).toBe(false);
  await expect.poll(() => scale(page), { timeout: 10_000 }).toBe(1);

  // e a pinça volta a ser barrada na Home
  await pinch(cdp, 180, 420);
  await page.waitForTimeout(400);
  expect(await scale(page), "pinça ampliou o jogo").toBe(1);
});

test("navegar entre páginas de leitura mantém o zoom liberado", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openReading(page, "/privacy", /Política de Privacidade/);
  await page.evaluate(() => {
    (
      document.querySelector(
        'main a[href="/delete-account"], a[href="/delete-account"]',
      ) as HTMLElement
    ).click();
  });
  await expect(page).toHaveURL(/\/delete-account$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /Excluir conta/ }),
  ).toBeVisible();
  expect(await meta(page)).toEqual([READING_VIEWPORT_CONTENT]);
  expect(await zoomAttr(page)).toBe(true);
});

test("abrir a Home direto segue em escala fixa", async ({ page }) => {
  await installSupabaseMock(page, homeBackend(false));
  await page.goto("/");
  await page.waitForTimeout(800);
  expect(await meta(page)).toEqual([VIEWPORT_CONTENT]);
  expect(await zoomAttr(page)).toBe(false);
});
