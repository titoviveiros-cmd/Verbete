// Fumaça visual de TODAS as telas, sem backend: o Supabase é simulado no
// navegador (supabase-mock.ts) com a partida de fixtures.ts. Checa o que
// quebra a tela (erro de página, rolagem horizontal, conteúdo-chave
// ausente) e, com SHOTS_DIR, salva as capturas para revisão visual.
//
//   npx playwright test e2e/visual                       → 390×844 (CI)
//   VISUAL_VIEWPORTS=all SHOTS_DIR=… npx playwright test e2e/visual
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock, type MockBackend } from "./supabase-mock";
import {
  blockedButtons,
  clippedByAncestors,
  floatingConflicts,
  floatingZoneIntrusions,
  truncatedTexts,
} from "./occlusion";
import {
  ROOM_CODE,
  ROOM_ID,
  dailyBackend,
  homeBackend,
  roomBackend,
  roomStorage,
  type Phase,
} from "./fixtures";

const ALL_VIEWPORTS = [
  [360, 800],
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
// VISUAL_AXE=1: auditoria WCAG 2.1 AA (axe-core) em cada tela simulada.
const AXE = process.env.VISUAL_AXE
  ? readFileSync(
      createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
      "utf8",
    )
  : null;

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
  opts: { guest?: boolean; voted?: boolean } = {},
): Screen => ({
  name: phase,
  path: `/room/${ROOM_CODE}`,
  backend: () => roomBackend(phase, { loggedIn, ...opts }),
  storage: roomStorage(phase, opts),
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
    // Verdade primeiro (~0,5 s); a captura espera o estado FINAL — todos os
    // blefes revelados e a contagem para o placar — para checar o layout cheio.
    await expect(
      page.getByText("A definição verdadeira", { exact: false }).first(),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("📊 Placar em").first()).toBeVisible({
      timeout: 25_000,
    });
    await page.waitForTimeout(1200);
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

// Variações do playtest 2026-10-20: a cédula escolhida (anel rosa) e as
// fases vistas por quem NÃO é o host (sem "Avançar agora"/"Próxima rodada").
const variant = (
  name: string,
  base: string,
  opts: { guest?: boolean; voted?: boolean },
  ready?: Screen["ready"],
) => {
  const b = SCREENS.find((s) => s.name === base)!;
  const phase = base as Phase;
  SCREENS.push({
    ...room(phase, ready ?? b.ready, base === "finished", opts),
    name,
  });
};
variant("voting-votado", "voting", { voted: true }, async (page) => {
  await expect(page.getByLabel("Voto registrado")).toBeVisible();
  await page.waitForTimeout(1200);
});
variant("lobby-convidado", "lobby", { guest: true });
variant("reveal-convidado", "reveal", { guest: true });
variant("scoreboard-convidado", "scoreboard", { guest: true });

// Tema claro (creme): mesmas telas-chave com a preferência salva, para
// conferir contraste e as peças fora da noite roxa. VISUAL_LIGHT=all: todas.
const LIGHT =
  process.env.VISUAL_LIGHT === "all"
    ? SCREENS.map((s) => s.name)
    : ["home-logada", "voting", "reveal", "diario-resultado"];
for (const name of LIGHT) {
  const base = SCREENS.find((s) => s.name === name)!;
  SCREENS.push({
    ...base,
    name: `${name}-claro`,
    storage: { ...(base.storage ?? {}), "verbete:theme": "light" },
  });
}

async function checkScreen(page: Page, screen: Screen, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const log = await installSupabaseMock(page, screen.backend());
  if (screen.storage) {
    await page.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
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
  expect(log.aborted, "chamadas ao Supabase sem resposta simulada").toEqual([]);

  if (AXE) {
    await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async () => {
      const w = window as unknown as {
        axe: {
          run: (
            ctx: Document,
            opts: object,
          ) => Promise<{
            violations: Array<{
              id: string;
              nodes: Array<{
                target: string[];
                any: Array<{ data?: { fgColor?: string } }>;
              }>;
            }>;
          }>;
        };
      };
      const r = await w.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return r.violations
        .map((v) => ({
          id: v.id,
          // Falso positivo conhecido (scripts/audit-a11y.mjs): o axe lê o
          // contorno roxo do wordmark como cor do texto.
          nodes: v.nodes
            .filter(
              (n) =>
                !(
                  v.id === "color-contrast" &&
                  n.any[0]?.data?.fgColor?.toLowerCase() === "#4c1a8f"
                ),
            )
            .map((n) => n.target.join(" ")),
        }))
        .filter((v) => v.nodes.length > 0);
    });
    expect(violations, "violações WCAG (axe)").toEqual([]);
  }

  if (SHOTS_DIR) {
    mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({
      path: join(SHOTS_DIR, `${screen.name}-${w}x${h}.png`),
    });
  }

  // "Compartilhar resultado" é da partida: só no fim de jogo. Na
  // revelação, o card é "Compartilhar rodada" (playtest 2026-10-20).
  if (screen.path.startsWith("/room/")) {
    await expect(
      page.getByText("Compartilhar resultado"),
      "Compartilhar resultado fora do fim de jogo",
    ).toHaveCount(screen.name.startsWith("finished") ? 1 : 0);
  }

  // Playtest 2026-10-20: corte por contêiner, reticências e a zona de
  // exclusão do 💬/▾. Antes do blockedButtons, que rola as listas.
  expect
    .soft(await clippedByAncestors(page), "cortado por contêiner")
    .toEqual([]);
  expect.soft(await truncatedTexts(page), "texto truncado").toEqual([]);
  expect
    .soft(
      await floatingZoneIntrusions(page),
      "conteúdo sob o 💬/▾ (zona de exclusão)",
    )
    .toEqual([]);

  // Nenhum botão cortado na lateral nem coberto por algo flutuante
  // (barra de reações, chat, rodapé fixo). Depois da captura: rola a página.
  expect(await blockedButtons(page), "botão cortado/coberto").toEqual([]);
}

for (const screen of SCREENS) {
  if (ONLY && !ONLY.includes(screen.name)) continue;
  for (const [w, h] of VIEWPORTS) {
    test(`${screen.name} @ ${w}x${h}`, async ({ page }) => {
      test.setTimeout(90_000);
      await checkScreen(page, screen, w, h);
    });
  }
}

// O celular mais estreito do playtest (Android 360×800) roda SEMPRE, também
// no CI: "Chame a galera!" inteiro, "Avançar agora" e "Próxima rodada"
// inteiros, anel rosa da cédula sem corte e nada sob o 💬/▾.
const NARROW = [
  "lobby",
  "lobby-convidado",
  "writing",
  "voting-votado",
  "reveal",
  "reveal-convidado",
  "scoreboard",
  "finished",
];
if (!VIEWPORTS.some(([w, h]) => w === 360 && h === 800)) {
  for (const name of NARROW) {
    const screen = SCREENS.find((s) => s.name === name)!;
    if (ONLY && !ONLY.includes(screen.name)) continue;
    test(`${screen.name} @ 360x800 (celular estreito)`, async ({ page }) => {
      test.setTimeout(90_000);
      await checkScreen(page, screen, 360, 800);
    });
  }
}

// Alvos que ficavam embaixo dos controles flutuantes (micro-rodada
// pré-loja): o 🚩 da última cédula sob o chat no celular em pé, e uma carta
// de palavra sob a barra de reações no celular deitado. Tamanhos fixos (rodam
// sempre, também no CI), incluindo os casos mais apertados.
const FLOATING: Array<{
  screen: string;
  target: string;
  sizes: Array<[number, number]>;
}> = [
  {
    screen: "voting",
    target: '[aria-label="Reportar definição"]',
    sizes: [
      [375, 812],
      [390, 844],
      [430, 932],
      [375, 667],
    ],
  },
  {
    screen: "choosing-palavras",
    target: "button.sticker",
    sizes: [
      [667, 375],
      [640, 360],
      [568, 320],
      [844, 390],
    ],
  },
];

for (const f of FLOATING) {
  const screen = SCREENS.find((s) => s.name === f.screen)!;
  for (const [w, h] of f.sizes) {
    test(`controles flutuantes: ${f.screen} @ ${w}x${h} — alvos inteiros e com folga`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: w, height: h });
      await installSupabaseMock(page, screen.backend());
      if (screen.storage) {
        await page.addInitScript((entries) => {
          for (const [k, v] of Object.entries(entries))
            localStorage.setItem(k, v);
        }, screen.storage);
      }
      await page.goto(screen.path);
      await screen.ready(page);
      expect(
        await floatingConflicts(page, f.target),
        "alvo sob controle flutuante",
      ).toEqual([]);
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return el.scrollWidth - window.innerWidth;
      });
      expect(overflow, "rolagem horizontal na página").toBeLessThanOrEqual(1);
    });
  }
}

// Denúncia e voto são alvos separados: o 🚩 (inclusive o da última cédula,
// perto do chat) abre a denúncia sem votar; tocar na cédula vota uma vez.
for (const [w, h] of [
  [375, 812],
  [390, 844],
] as const) {
  test(`votação @ ${w}x${h}: 🚩 abre a denúncia sem votar e a cédula vota uma vez`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: w, height: h });
    const log = await installSupabaseMock(page, roomBackend("voting"));
    await page.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, roomStorage("voting"));
    await page.goto(`/room/${ROOM_CODE}`);
    await expect(
      page.getByText("tambor de couro", { exact: false }),
    ).toBeVisible();
    await page.waitForTimeout(1200);
    const votes = () =>
      log.calls.filter((c) => c === "POST /rest/v1/rpc/cast_vote").length;

    // Sem force: se o chat (ou qualquer coisa) interceptar o toque, reprova.
    const lastFlag = page
      .getByRole("button", { name: "Reportar definição" })
      .last();
    await lastFlag.scrollIntoViewIfNeeded();
    await lastFlag.click();
    const cancel = page.getByRole("button", { name: "Cancelar" });
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect(cancel).toBeHidden();
    await page.waitForTimeout(400);
    expect(votes(), "o 🚩 disparou voto").toBe(0);
    await expect(page.getByLabel("Voto registrado")).toHaveCount(0);

    // (o "✓ Voto registrado" é otimista e o polling do simulador, que não
    // guarda votos, o apaga logo depois — por isso conta-se a chamada)
    const ballot = page.locator("button:has(.token):not([disabled])").last();
    await ballot.scrollIntoViewIfNeeded();
    await ballot.click();
    await expect.poll(votes, { timeout: 5_000 }).toBe(1);
    await page.waitForTimeout(800);
    expect(votes(), "um toque na cédula = um voto").toBe(1);
    await expect(cancel).toBeHidden(); // votar não abre a denúncia
  });
}

// Transição de fase nova (playtest 2026-10-20): mascote + rodada + título em
// ouro + fio dourado. No celular mais estreito, claro e escuro: título e dica
// inteiros, nada cortado, nada fora da tela. A virada é a mesma que o app faz
// ao receber a fase nova (evento de atualização otimista da sala).
const TRANSITIONS = [
  { status: "choosing", title: "Escolha da Palavra", round: 4 },
  { status: "writing", title: "Hora de Inventar", round: 4 },
  { status: "scoreboard", title: "Placar da Rodada", round: 3 },
  { status: "finished", title: "Fim de Jogo", round: 3 },
] as const;
for (const tr of TRANSITIONS) {
  for (const theme of ["escuro", "claro"] as const) {
    test(`transição ${tr.status} (${theme}) @ 360x800: título inteiro, nada cortado`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: 360, height: 800 });
      await installSupabaseMock(page, roomBackend("lobby"));
      await page.addInitScript(
        (entries) => {
          for (const [k, v] of Object.entries(entries))
            localStorage.setItem(k, v);
        },
        {
          ...roomStorage("lobby"),
          ...(theme === "claro" ? { "verbete:theme": "light" } : {}),
        },
      );
      await page.goto(`/room/${ROOM_CODE}`);
      await expect(page.getByText("Jogadores (4/12)")).toBeVisible();
      await page.waitForTimeout(600);
      await page.evaluate(
        ([roomId, status, round]) =>
          window.dispatchEvent(
            new CustomEvent("room:optimistic-update", {
              detail: { roomId, patch: { status, current_round: round } },
            }),
          ),
        [ROOM_ID, tr.status, tr.round] as const,
      );
      const overlay = page.locator(`[data-phase-announcer="${tr.status}"]`);
      await expect(overlay.locator("h2")).toHaveText(tr.title);
      await page.waitForTimeout(1000); // entrada completa (≈0,9 s)
      if (SHOTS_DIR) {
        mkdirSync(SHOTS_DIR, { recursive: true });
        await page.screenshot({
          path: join(SHOTS_DIR, `transicao-${tr.status}-${theme}-360x800.png`),
        });
      }
      for (const el of await overlay.locator("h2, p").all()) {
        const b = (await el.boundingBox())!;
        expect(b.x, "fora da tela à esquerda").toBeGreaterThanOrEqual(0);
        expect(b.x + b.width, "fora da tela à direita").toBeLessThanOrEqual(
          360,
        );
      }
      expect(await truncatedTexts(page), "texto truncado").toEqual([]);
    });
  }
}
