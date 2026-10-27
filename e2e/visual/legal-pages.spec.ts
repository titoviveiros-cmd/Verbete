// Páginas legais e de exclusão de conta (rodada 2A da conformidade Google
// Play): renderizam em celular pequeno e no desktop sem rolagem lateral nem
// erro, passam no axe (WCAG 2.1 AA), mostram o contato oficial e — a de
// exclusão — saem prontas no HTML do servidor (revisor sem JavaScript) e
// sem login. Backend simulado (supabase-mock): nada sai da máquina.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { homeBackend } from "./fixtures";
import { CONTACT_EMAIL } from "../../src/lib/legal";

const AXE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

const PAGES = [
  { path: "/privacy", h1: "Política de Privacidade" },
  { path: "/terms", h1: "Termos de Uso" },
  { path: "/support", h1: "Suporte" },
  { path: "/download", h1: "Verbete" },
  { path: "/delete-account", h1: "Excluir conta" },
] as const;

const VIEWPORTS = [
  { name: "celular pequeno", width: 320, height: 568 },
  { name: "desktop", width: 1366, height: 768 },
] as const;

async function wcag(page: Page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const w = window as unknown as {
      axe: {
        run: (
          ctx: Document,
          o: object,
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
      // A meta viewport é GLOBAL e trava o zoom de propósito ("escala fixa
      // de jogo", 2º playtest 20/10 — zoom.spec.ts). Liberar o zoom nas
      // páginas de texto é decisão pendente do proprietário (relatório da
      // rodada 2A, P2), não destas páginas.
      rules: { "meta-viewport": { enabled: false } },
    });
    return r.violations
      .map((v) => ({
        id: v.id,
        // falso positivo conhecido (scripts/audit-a11y.mjs): o axe lê o
        // contorno roxo do wordmark como cor do texto
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
}

for (const vp of VIEWPORTS) {
  test.describe(`páginas legais — ${vp.name} (${vp.width}×${vp.height})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const p of PAGES) {
      test(`${p.path}: abre sem login, sem rolagem lateral, contato oficial e WCAG AA`, async ({
        page,
      }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const log = await installSupabaseMock(page, homeBackend(false));
        await page.goto(p.path);
        await expect(
          page.getByRole("heading", { level: 1, name: p.h1 }),
        ).toBeVisible({ timeout: 25_000 });

        const overflow = await page.evaluate(() => {
          const el = document.scrollingElement ?? document.documentElement;
          return el.scrollWidth - window.innerWidth;
        });
        expect(overflow, "rolagem horizontal").toBeLessThanOrEqual(1);

        const mail = page.locator(`a[href^="mailto:${CONTACT_EMAIL}"]`);
        expect(await mail.count(), "link do contato oficial").toBeGreaterThan(
          0,
        );
        expect(await page.content()).not.toContain("@verbete.app");
        await expect(page.getByText(/TestFlight|12\+/)).toHaveCount(0);

        expect(await wcag(page), "violações WCAG (axe)").toEqual([]);
        expect(errors, "erros de página").toEqual([]);
        expect(log.aborted, "Supabase sem resposta simulada").toEqual([]);
      });
    }
  });
}

test("/support leva à página de exclusão; ela leva à Privacidade e ao Suporte", async ({
  page,
}) => {
  await installSupabaseMock(page, homeBackend(false));
  await page.goto("/support");
  const link = page.getByRole("link", { name: "Excluir conta" }).first();
  await expect(link).toBeVisible({ timeout: 25_000 });
  await link.click();
  await expect(page).toHaveURL(/\/delete-account$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Excluir conta" }),
  ).toBeVisible();
  // pedido externo: e-mail oficial com assunto e roteiro já preenchidos
  const ask = page.getByRole("link", { name: "Pedir exclusão por e-mail" });
  const href = (await ask.getAttribute("href")) ?? "";
  expect(href.startsWith(`mailto:${CONTACT_EMAIL}?subject=`)).toBe(true);
  expect(decodeURIComponent(href)).toContain("Excluir minha conta do Verbete");
  expect(decodeURIComponent(href)).toContain("E-mail da conta:");
  await page.getByRole("link", { name: "Política de Privacidade" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("link", { name: "Excluir conta" })).toBeVisible();
});

test.describe("sem JavaScript (revisor da loja, robôs)", () => {
  test.use({ javaScriptEnabled: false });

  test("/delete-account sai pronta no HTML do servidor", async ({ page }) => {
    await page.goto("/delete-account");
    await expect(
      page.getByRole("heading", { level: 1, name: "Excluir conta" }),
    ).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText("O que é apagado")).toBeVisible();
    await expect(page.getByText("O que permanece")).toBeVisible();
    await expect(
      page.getByRole("link", { name: CONTACT_EMAIL }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Pedir exclusão por e-mail" }),
    ).toBeVisible();
  });
});
