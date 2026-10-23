// Toque não atravessa a cortina de fase (Red Team 2026-10-20): a cortina é
// opaca, então um toque nela — "para pular" — acertava às cegas o botão da
// fase por baixo (Sortear palavra, Próxima rodada, Sair). Mede com o mesmo
// teste de acerto que o navegador usa para rotear o toque
// (document.elementFromPoint) e exige que o botão volte a ser tocável assim
// que a cortina começa a sair.
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { ROOM_CODE, ROOM_ID, roomBackend, roomStorage } from "./fixtures";

/** O toque no centro do "Sortear palavra" (procurado e medido agora: ele
 *  entra animado e remonta) chega ao botão? Devolve o que foi acertado. */
const probe = (page: Page) =>
  page.evaluate(() => {
    const t = [...document.querySelectorAll("button")].find((b) =>
      /Sortear palavra/.test(b.textContent ?? ""),
    );
    if (!t) return { inside: false, hit: "sem botão" };
    const r = t.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    return {
      inside: !!hit && t.contains(hit),
      hit: hit
        ? `${hit.tagName} ${String(hit.className).slice(0, 60)}`
        : "nada",
    };
  });

const setStatus = (page: Page, status: string) =>
  page.evaluate(
    ([roomId, s]) =>
      window.dispatchEvent(
        new CustomEvent("room:optimistic-update", {
          detail: { roomId, patch: { status: s } },
        }),
      ),
    [ROOM_ID, status] as const,
  );

test("cortina de fase: o toque não chega ao botão escondido e volta quando ela sai", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 360, height: 800 });
  // Escolha da Palavra com EU (Bia) de coordenadora: "Sortear palavra" no
  // meio da tela. A cortina só aparece numa VIRADA de fase, então a sala sai
  // e volta (o banco simulado segue em "choosing" — o poll não desfaz nada).
  await installSupabaseMock(page, roomBackend("choosing"));
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("choosing"));
  await page.goto(`/room/${ROOM_CODE}`);
  await expect(
    page.getByRole("button", { name: /Sortear palavra/ }),
  ).toBeVisible({ timeout: 25_000 });
  expect((await probe(page)).inside, "sem cortina o botão é tocável").toBe(
    true,
  );
  await setStatus(page, "lobby");
  await page.waitForTimeout(300);
  await setStatus(page, "choosing");
  const t0 = Date.now();
  const overlay = page.locator('[data-phase-announcer="choosing"]');
  await expect(overlay.locator("h2")).toHaveText("Escolha da Palavra");
  await expect(
    page.getByRole("button", { name: /Sortear palavra/ }),
  ).toBeAttached();

  // Durante a cortina: nem o centro do botão nem nenhum ponto da tela chega
  // ao conteúdo da fase.
  await page.waitForTimeout(700);
  const during = await probe(page);
  expect(Date.now() - t0, "medição fora da janela da cortina").toBeLessThan(
    2400,
  );
  expect
    .soft(
      during.inside,
      `o toque na cortina chegou ao «Sortear palavra» escondido (${during.hit})`,
    )
    .toBe(false);
  const leaks = await page.evaluate(() => {
    const out: string[] = [];
    for (let gx = 1; gx <= 3; gx++)
      for (let gy = 1; gy <= 5; gy++) {
        const x = (window.innerWidth * gx) / 4;
        const y = (window.innerHeight * gy) / 6;
        const hit = document.elementFromPoint(x, y);
        const inCurtain = hit?.closest(
          "[data-phase-announcer], [data-phase-announcer-shield]",
        );
        if (hit && !inCurtain && hit.closest("button, a, input, textarea"))
          out.push(`${Math.round(x)},${Math.round(y)} → ${hit.tagName}`);
      }
    return out;
  });
  expect
    .soft(leaks, "pontos da tela que tocam controles escondidos")
    .toEqual([]);

  // Assim que a cortina começa a sair (2,8 s), o botão volta a ser tocável.
  await expect(async () => {
    const after = await probe(page);
    expect(after.inside, `depois da cortina acertou ${after.hit}`).toBe(true);
  }).toPass({ timeout: 3_000, intervals: [100] });
  expect(Date.now() - t0, "o botão demorou a voltar").toBeLessThan(3_600);
});
