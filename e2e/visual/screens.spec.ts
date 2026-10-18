// Fumaça visual de TODAS as telas, sem backend: o Supabase é simulado no
// navegador (supabase-mock.ts) com a partida de fixtures.ts. Checa o que
// quebra a tela (erro de página, rolagem horizontal, conteúdo-chave
// ausente) e, com SHOTS_DIR, salva as capturas para revisão visual.
//
//   npx playwright test e2e/visual                       → 390×844 (CI)
//   VISUAL_VIEWPORTS=all SHOTS_DIR=… npx playwright test e2e/visual
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock, type MockBackend } from "./supabase-mock";
import {
  ROOM_CODE,
  dailyBackend,
  homeBackend,
  roomBackend,
  roomStorage,
  type Phase,
} from "./fixtures";

const ALL_VIEWPORTS = [
  [375, 812],
  [390, 844],
  [430, 932],
  [667, 375],
  [768, 1024],
  [1366, 768],
  [1920, 1080],
] as const;

const wanted = process.env.VISUAL_VIEWPORTS ?? "390x844";
const VIEWPORTS =
  wanted === "all"
    ? ALL_VIEWPORTS
    : ALL_VIEWPORTS.filter(([w, h]) => wanted.split(",").includes(`${w}x${h}`));
const ONLY = process.env.VISUAL_SCREENS?.split(",");
const SHOTS_DIR = process.env.SHOTS_DIR;

type Screen = {
  name: string;
  path: string;
  backend: () => MockBackend;
  storage?: Record<string, string>;
  /** Espera a tela "assentar" (animações de entrada / coreografia). */
  ready: (page: Page) => Promise<void>;
};

const room = (
  phase: Phase,
  ready: Screen["ready"],
  loggedIn = false,
): Screen => ({
  name: phase,
  path: `/room/${ROOM_CODE}`,
  backend: () => roomBackend(phase, { loggedIn }),
  storage: roomStorage(phase),
  ready,
});

const SCREENS: Screen[] = [
  {
    name: "home",
    path: "/",
    backend: () => homeBackend(false),
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Verbete" }),
      ).toBeVisible();
      await page.waitForTimeout(1500);
    },
  },
  {
    name: "home-logada",
    path: "/",
    backend: () => homeBackend(true),
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Verbete" }),
      ).toBeVisible();
      await page.waitForTimeout(2200);
    },
  },
  {
    name: "diario",
    path: "/daily",
    backend: () => dailyBackend("play"),
    ready: async (page) => {
      await expect(
        page.getByText("alvíssaras", { exact: false }).first(),
      ).toBeVisible();
      await page.waitForTimeout(1500);
    },
  },
  {
    name: "diario-resultado",
    path: "/daily",
    backend: () => dailyBackend("result"),
    ready: async (page) => {
      await expect(
        page.getByText("Significado correto", { exact: false }).first(),
      ).toBeVisible();
      await page.waitForTimeout(2000);
    },
  },
  room("lobby", async (page) => {
    await expect(page.getByText("Jogadores (4/12)")).toBeVisible();
    await page.waitForTimeout(1500);
  }),
  room("choosing", async (page) => {
    await expect(
      page.getByRole("button", { name: /Sortear palavra/ }),
    ).toBeVisible();
    await page.waitForTimeout(1200);
  }),
  {
    ...room("choosing", async (page) => {
      const draw = page.getByRole("button", { name: /Sortear palavra/ });
      await expect(
        draw.or(page.getByText("quiproquó", { exact: false })),
      ).toBeVisible();
      if (await draw.isVisible()) await draw.click({ force: true });
      await expect(page.getByText("quiproquó", { exact: false })).toBeVisible({
        timeout: 8000,
      });
      await page.waitForTimeout(1200);
    }),
    name: "choosing-palavras",
  },
  room("writing", async (page) => {
    await expect(
      page.getByPlaceholder("escreva sua definicao mirabolante..."),
    ).toBeVisible();
    await page.waitForTimeout(1500);
  }),
  room("shuffling", async (page) => {
    await expect(
      page.getByText("Embaralhando", { exact: false }).first(),
    ).toBeVisible();
    await page.waitForTimeout(700);
  }),
  room("voting", async (page) => {
    await expect(
      page.getByText("tambor de couro", { exact: false }),
    ).toBeVisible();
    await page.waitForTimeout(1200);
  }),
  room("reveal", async (page) => {
    await expect(
      page.getByText("A definição verdadeira", { exact: false }).first(),
    ).toBeVisible({
      timeout: 25_000,
    });
    await page.waitForTimeout(2500);
  }),
  room("scoreboard", async (page) => {
    await expect(
      page.getByText("Acertou a verdade", { exact: false }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(5500);
  }),
  room(
    "finished",
    async (page) => {
      await expect(
        page.getByText("Fim de jogo", { exact: false }).first(),
      ).toBeVisible();
      await page.waitForTimeout(3500);
    },
    true,
  ),
];

// Tema claro (creme): mesmas telas-chave com a preferência salva, para
// conferir contraste e as peças fora da noite roxa.
const LIGHT = ["home-logada", "voting", "reveal", "diario-resultado"];
for (const name of LIGHT) {
  const base = SCREENS.find((s) => s.name === name)!;
  SCREENS.push({
    ...base,
    name: `${name}-claro`,
    storage: { ...(base.storage ?? {}), "verbete:theme": "light" },
  });
}

for (const screen of SCREENS) {
  if (ONLY && !ONLY.includes(screen.name)) continue;
  for (const [w, h] of VIEWPORTS) {
    test(`${screen.name} @ ${w}x${h}`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: w, height: h });
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));
      const log = await installSupabaseMock(page, screen.backend());
      if (screen.storage) {
        await page.addInitScript((entries) => {
          for (const [k, v] of Object.entries(entries))
            localStorage.setItem(k, v);
        }, screen.storage);
      }
      // O dev server às vezes recarrega a página logo após a 1ª carga
      // (otimização de dependências do Vite / auto-update de bundle): se
      // houve recarga durante a espera, espera de novo na página nova.
      let navigations = 0;
      page.on("framenavigated", (f) => {
        if (f === page.mainFrame()) navigations++;
      });
      await page.goto(screen.path);
      await screen.ready(page);
      if (navigations > 1) await screen.ready(page);

      // Nada pode empurrar a página para os lados.
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return el.scrollWidth - window.innerWidth;
      });
      expect(overflow, "rolagem horizontal na página").toBeLessThanOrEqual(1);
      expect(pageErrors, "erros de página").toEqual([]);
      // O mock aborta qualquer rota desconhecida do Supabase: se algo
      // escapou, a fixture está incompleta (e a tela pode estar mentindo).
      expect(log.aborted, "chamadas ao Supabase sem resposta simulada").toEqual(
        [],
      );

      if (SHOTS_DIR) {
        mkdirSync(SHOTS_DIR, { recursive: true });
        await page.screenshot({
          path: join(SHOTS_DIR, `${screen.name}-${w}x${h}.png`),
        });
      }
    });
  }
}
