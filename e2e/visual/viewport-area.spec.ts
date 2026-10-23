// Régua da área rolável (playtest 2026-10-20, 2ª rodada): mede, em cada
// fase, a altura da lista que ROLA (o conteúdo) e o quanto da tela ficou
// congelado em cima e embaixo dela. Só com VIEWPORT_AREA=1; aceita
// E2E_BASE_URL (ex.: a prévia antiga) para comparar antes/depois com o mesmo
// simulador de backend.
//
//   VIEWPORT_AREA=1 npx playwright test e2e/visual/viewport-area.spec.ts
import { expect, test } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage, type Phase } from "./fixtures";

test.skip(!process.env.VIEWPORT_AREA, "só com VIEWPORT_AREA=1");

// `marker`: um elemento do CONTEÚDO da fase; a área medida é a lista que
// rola e o contém (o ancestral mais próximo com rolagem vertical).
const CASES: Array<{ phase: Phase; ready: RegExp; marker: string }> = [
  { phase: "lobby", ready: /Jogadores \(4\/12\)/, marker: ".panel h3" },
  { phase: "writing", ready: /mirabolante|Rapapé/i, marker: "textarea" },
  { phase: "voting", ready: /tambor de couro/, marker: "button .token" },
  { phase: "reveal", ready: /Placar em/, marker: '[role="region"] > *' },
  {
    phase: "scoreboard",
    ready: /Acertou a verdade/,
    marker: '[role="region"] > *',
  },
  { phase: "finished", ready: /Fim de jogo/i, marker: ".podium-gold" },
];

for (const [w, h] of [
  [360, 800],
  [390, 844],
] as const) {
  for (const c of CASES) {
    test(`área rolável: ${c.phase} @ ${w}x${h}`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: w, height: h });
      await installSupabaseMock(
        page,
        roomBackend(c.phase, { loggedIn: c.phase === "finished" }),
      );
      await page.addInitScript((entries) => {
        for (const [k, v] of Object.entries(entries))
          localStorage.setItem(k, v);
      }, roomStorage(c.phase));
      await page.goto(`/room/${ROOM_CODE}`);
      await expect(page.getByText(c.ready).first()).toBeVisible({
        timeout: 25_000,
      });
      await page.waitForTimeout(1500);
      const m = await page.evaluate((marker) => {
        const start = document.querySelector(marker);
        let el = start?.parentElement ?? null;
        while (el && el !== document.body) {
          const oy = getComputedStyle(el).overflowY;
          if (oy === "auto" || oy === "scroll") break;
          el = el.parentElement;
        }
        const r = el?.getBoundingClientRect();
        return {
          rolavel: el ? Math.round(el.clientHeight) : 0,
          topo: r ? Math.round(r.top) : 0,
          baixo: r ? Math.round(window.innerHeight - r.bottom) : 0,
        };
      }, c.marker);
      console.log(
        `AREA ${c.phase} ${w}x${h} rolavel=${m.rolavel} congelado_topo=${m.topo} congelado_baixo=${m.baixo}`,
      );
    });
  }
}
