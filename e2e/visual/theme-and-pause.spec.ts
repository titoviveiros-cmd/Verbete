// Consolidação do playtest (2026-10-21):
//  • Tema CLARO como padrão — primeira visita abre clara já na primeira
//    pintura (o script do <head> roda antes do <body>), "dark" salvo segue
//    escuro e a escolha sobrevive ao recarregar. Home, convite, login e sala.
//  • Partida PAUSADA — a faixa "⏸️ Partida pausada · ▶ Continuar" aparece
//    inteira, sem cobrir controles, em 360/375/390/430, claro e escuro.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import {
  homeBackend,
  ROOM_CODE,
  ROOM_ID,
  roomBackend,
  roomStorage,
} from "./fixtures";
import {
  blockedButtons,
  clippedByAncestors,
  floatingConflicts,
  truncatedTexts,
} from "./occlusion";

const SHOTS_DIR = process.env.SHOTS_DIR;

/** Classe do <html> no instante em que o <body> nasce (antes da 1ª pintura). */
async function recordFirstPaintTheme(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __firstTheme?: string };
    const grab = () => {
      if (w.__firstTheme === undefined && document.body)
        w.__firstTheme = document.documentElement.classList.contains("light")
          ? "light"
          : "dark";
    };
    new MutationObserver(grab).observe(document, {
      childList: true,
      subtree: true,
    });
  });
}
const firstTheme = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __firstTheme?: string }).__firstTheme,
  );
const nowTheme = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.classList.contains("light") ? "light" : "dark",
  );

const PAGES = [
  { name: "home", path: "/", ready: /Criar sala|Entrar/i },
  { name: "convite", path: `/?join=${ROOM_CODE}`, ready: /Entrar|apelido/i },
  { name: "login", path: "/login", ready: /Entrar|Google|e-mail/i },
];

for (const pg of PAGES) {
  test(`tema: primeira visita em ${pg.name} abre CLARA desde a 1ª pintura`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await recordFirstPaintTheme(page);
    await installSupabaseMock(page, homeBackend(false));
    await page.goto(pg.path);
    await expect(page.getByText(pg.ready).first()).toBeVisible({
      timeout: 25_000,
    });
    expect(await firstTheme(page), "1ª pintura").toBe("light");
    expect(await nowTheme(page)).toBe("light");
    expect(
      await page.evaluate(() =>
        document
          .querySelector('meta[name="theme-color"]')
          ?.getAttribute("content"),
      ),
    ).toBe("#fbf3e3");
  });
}

test("tema: escuro salvo segue escuro desde a 1ª pintura e após recarregar", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await recordFirstPaintTheme(page);
  await installSupabaseMock(page, homeBackend(false));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("verbete:theme", "dark");
      sessionStorage.setItem("seeded", "1");
    }
  });
  await page.goto("/");
  await expect(page.getByText(/Criar sala|Entrar/i).first()).toBeVisible({
    timeout: 25_000,
  });
  expect(await firstTheme(page), "1ª pintura com escuro salvo").toBe("dark");
  await page.reload();
  await expect(page.getByText(/Criar sala|Entrar/i).first()).toBeVisible();
  expect(await firstTheme(page), "após recarregar").toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("verbete:theme"))).toBe(
    "dark",
  );
});

test("tema: escolher escuro no botão persiste no recarregar; voltar ao claro também", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await recordFirstPaintTheme(page);
  await installSupabaseMock(page, homeBackend(false));
  await page.goto("/");
  await expect(page.getByText(/Criar sala|Entrar/i).first()).toBeVisible({
    timeout: 25_000,
  });
  // clique só conta depois da hidratação: tenta até o tema virar
  await expect(async () => {
    await page.getByRole("button", { name: "Mudar para tema escuro" }).click();
    expect(await nowTheme(page)).toBe("dark");
  }).toPass({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByText(/Criar sala|Entrar/i).first()).toBeVisible();
  expect(await firstTheme(page)).toBe("dark");
  await expect(async () => {
    await page.getByRole("button", { name: "Mudar para tema claro" }).click();
    expect(await nowTheme(page)).toBe("light");
  }).toPass({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByText(/Criar sala|Entrar/i).first()).toBeVisible();
  expect(await firstTheme(page)).toBe("light");
});

test("tema: sala (partida) também abre clara na primeira visita", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await recordFirstPaintTheme(page);
  await installSupabaseMock(page, roomBackend("writing"));
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("writing"));
  await page.goto(`/room/${ROOM_CODE}`);
  await expect(page.getByText(/mirabolante|Rapapé/i).first()).toBeVisible({
    timeout: 25_000,
  });
  expect(await firstTheme(page)).toBe("light");
});

const SIZES = (
  process.env.VISUAL_VIEWPORTS ?? "360x800,375x812,390x844,430x932"
)
  .split(",")
  .map((s) => s.split("x").map(Number) as [number, number]);

for (const [w, h] of SIZES) {
  for (const theme of ["claro", "escuro"] as const) {
    test(`partida pausada (${theme}) @ ${w}x${h}: faixa inteira, Continuar tocável`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: w, height: h });
      const backend = roomBackend("writing");
      const room = (backend.tables["rooms"] as Record<string, unknown>[]).find(
        (r) => r.id === ROOM_ID,
      )!;
      room.paused_at = new Date(Date.now() - 5 * 60_000).toISOString();
      room.round_phase_ends_at = new Date(
        Date.now() - 6 * 60_000,
      ).toISOString();
      await installSupabaseMock(page, backend);
      await page.addInitScript(
        (entries) => {
          for (const [k, v] of Object.entries(entries))
            localStorage.setItem(k, v);
        },
        {
          ...roomStorage("writing"),
          "verbete:theme": theme === "claro" ? "light" : "dark",
        },
      );
      await page.goto(`/room/${ROOM_CODE}`);
      const banner = page.locator("[data-paused-banner]");
      await expect(banner).toBeVisible({ timeout: 25_000 });
      await expect(banner.getByText("Partida pausada")).toBeVisible();
      await page.waitForTimeout(800);
      if (SHOTS_DIR) {
        mkdirSync(SHOTS_DIR, { recursive: true });
        await page.screenshot({
          path: join(SHOTS_DIR, `pausada-${theme}-${w}x${h}.png`),
        });
      }
      const btn = banner.getByRole("button", { name: /Continuar/ });
      await expect(btn).toBeVisible();
      const b = (await btn.boundingBox())!;
      expect(b.x, "Continuar fora da tela à esquerda").toBeGreaterThanOrEqual(
        8,
      );
      expect(
        b.x + b.width,
        "Continuar fora da tela à direita",
      ).toBeLessThanOrEqual(w - 8);
      expect(b.height, "área de toque").toBeGreaterThanOrEqual(32);
      const hit = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return !!el?.closest("[data-paused-banner] button");
        },
        [b.x + b.width / 2, b.y + b.height / 2] as const,
      );
      expect(hit, "Continuar recebe o toque").toBe(true);
      expect(await truncatedTexts(page), "texto truncado").toEqual([]);
      expect(await blockedButtons(page), "botão coberto").toEqual([]);
      expect(await clippedByAncestors(page), "cortado").toEqual([]);
      expect(
        await floatingConflicts(page, "[data-paused-banner] button"),
        "flutuantes em conflito",
      ).toEqual([]);
      // o countdown vencido não dispara nada enquanto pausada (sem RPC de prazo)
      const calls: string[] = [];
      page.on("request", (r) => {
        if (/extend_writing_or_advance|start_shuffling/.test(r.url()))
          calls.push(r.url());
      });
      await page.waitForTimeout(1500);
      expect(calls, "pausada não chama prorrogação/embaralhamento").toEqual([]);
    });
  }
}
