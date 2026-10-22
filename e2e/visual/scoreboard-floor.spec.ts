// Placar (playtest 2026-10-22): logo que a cortina saía, o host já podia
// tocar "Próxima rodada" e o placar aparecia por meio segundo, com as
// fileiras ainda entrando. Agora o botão destrava ~2,5 s depois da cortina.
import { expect, test } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage } from "./fixtures";

test("placar: 'Próxima rodada' só destrava ~2,5 s depois da cortina", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await installSupabaseMock(page, roomBackend("scoreboard"));
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("scoreboard"));
  await page.goto(`/room/${ROOM_CODE}`);
  const next = page.getByRole("button", { name: /Próxima rodada/ });
  await expect(next).toBeVisible({ timeout: 25_000 });
  const shownAt = Date.now();
  // cortina inteira (3,5 s) + 0,5 s: as fileiras ainda estão entrando
  await page.waitForTimeout(4_000);
  await expect(next, "ainda não dá para pular o placar").toBeDisabled();
  await expect(next).toBeEnabled({ timeout: 4_000 });
  const readyAfter = Date.now() - shownAt;
  console.log(`'Próxima rodada' destravou ${readyAfter} ms depois de aparecer`);
  expect(readyAfter).toBeLessThanOrEqual(6_800);
});
