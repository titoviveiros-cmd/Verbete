// Escala fixa de jogo (2º playtest 2026-10-20): pinça e duplo toque NÃO
// ampliam a tela, mas a lista continua rolando e o campo de texto continua
// digitável. Chromium em modo celular (isMobile + hasTouch aplica a meta
// viewport, como o Chrome Android e o WebView do Capacitor); os dedos entram
// como toques reais do navegador (CDP Input.dispatchTouchEvent), que passam
// pelo reconhecedor de gestos — não são eventos JS forjados. (Os
// Input.synthesize*Gesture do CDP não fazem nada neste headless: nem com a
// viewport antiga, de zoom liberado, ampliavam ou rolavam.)
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage, type Phase } from "./fixtures";

test.use({
  viewport: { width: 360, height: 800 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

async function open(page: Page, phase: Phase, ready: RegExp) {
  await installSupabaseMock(
    page,
    roomBackend(phase, { loggedIn: phase === "finished" }),
  );
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage(phase));
  await page.goto(`/room/${ROOM_CODE}`);
  await expect(page.getByText(ready).first()).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(1500);
  return page.context().newCDPSession(page);
}

const scale = (page: Page) =>
  page.evaluate(() => window.visualViewport?.scale ?? 1);

type Pt = { x: number; y: number };
/** Dedos (1 = arrasto, 2 = pinça) indo de `from` a `to` em passos. */
async function fingers(cdp: CDPSession, from: Pt[], to: Pt[], steps = 12) {
  const at = (k: number) =>
    from.map((p, id) => ({
      id,
      x: p.x + ((to[id]!.x - p.x) * k) / steps,
      y: p.y + ((to[id]!.y - p.y) * k) / steps,
    }));
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

test("pinça e duplo toque não ampliam; a lista continua rolando", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const cdp = await open(page, "finished", /Fim de jogo/i);
  expect(await scale(page)).toBe(1);

  // A lista do pódio precisa rolar de verdade (caso difícil: há o que rolar).
  const box = await page.evaluate(() => {
    let el = document.querySelector(".podium-gold")?.parentElement ?? null;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      el = el.parentElement;
    }
    if (!el || el === document.body) return null;
    el.setAttribute("data-zoom-scroller", "");
    const r = el.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      top: r.y,
      h: r.height,
      folga: el.scrollHeight - el.clientHeight,
    };
  });
  expect(box, "lista rolável do Fim de Jogo").not.toBeNull();
  expect(box!.folga, "a lista tem o que rolar").toBeGreaterThan(40);
  const { x, top, h } = box!;

  // Pinça abrindo de 60px a 260px no meio da lista.
  const mid = top + h / 2;
  await fingers(
    cdp,
    [
      { x: x - 30, y: mid },
      { x: x + 30, y: mid },
    ],
    [
      { x: x - 130, y: mid },
      { x: x + 130, y: mid },
    ],
  );
  await page.waitForTimeout(400);
  expect(await scale(page), "pinça ampliou a tela").toBe(1);

  await page.touchscreen.tap(x, top + h * 0.3);
  await page.waitForTimeout(60);
  await page.touchscreen.tap(x, top + h * 0.3);
  await page.waitForTimeout(400);
  expect(await scale(page), "duplo toque ampliou a tela").toBe(1);

  const scroller = page.locator("[data-zoom-scroller]");
  const before = await scroller.evaluate((el) => el.scrollTop);
  await fingers(cdp, [{ x, y: top + h * 0.8 }], [{ x, y: top + h * 0.2 }]);
  await page.waitForTimeout(600);
  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(after - before, "a rolagem por toque foi barrada").toBeGreaterThan(20);
  expect(await scale(page)).toBe(1);
});

test("o campo de texto recebe toque e teclado sem ampliar (≥16px, sem zoom do iOS)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await open(page, "writing", /mirabolante|Rapapé/i);
  const ta = page.locator("textarea").first();
  await expect(ta).toBeVisible();
  const fs = await ta.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  expect(
    fs,
    "fonte < 16px faz o Safari iOS ampliar no foco",
  ).toBeGreaterThanOrEqual(16);
  const r = (await ta.boundingBox())!;
  await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  await expect(ta).toBeFocused();
  await page.keyboard.type("teste de toque");
  await expect(ta).toHaveValue(/teste de toque/);
  expect(await scale(page)).toBe(1);
});
