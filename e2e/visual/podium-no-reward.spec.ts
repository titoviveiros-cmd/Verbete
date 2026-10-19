// P2 XP — pódio de sala encerrada pela limpeza: o servidor responde
// ok=false / match_not_rewardable / xp_gained 0. O pódio tem que aparecer
// igual, sem chip de XP, sem erro de página e sem nova tentativa (uma única
// chamada). O caso de controle (resposta normal) prova que o teste enxerga o
// chip quando ele existe — sem ele, "chip ausente" passaria por cegueira.
import { expect, test } from "@playwright/test";
import { installSupabaseMock, type Json } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage } from "./fixtures";

const CASES: Array<{ name: string; result?: Json; chip: boolean }> = [
  { name: "partida normal (controle)", chip: true },
  {
    name: "sala encerrada pela limpeza",
    result: { ok: false, reason: "match_not_rewardable", xp_gained: 0 },
    chip: false,
  },
];

for (const c of CASES) {
  test(`pódio — ${c.name}`, async ({ page }) => {
    test.setTimeout(60_000);
    const backend = roomBackend("finished", { loggedIn: true });
    if (c.result !== undefined) backend.rpc.record_match_result = c.result;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const log = await installSupabaseMock(page, backend);
    await page.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, roomStorage("finished"));
    await page.goto(`/room/${ROOM_CODE}`);
    await expect(
      page.getByText("Fim de jogo", { exact: false }).first(),
    ).toBeVisible({ timeout: 25_000 });
    const calls = () =>
      log.calls.filter((x) => x.includes("rpc/record_match_result")).length;
    await expect.poll(calls, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(1500); // tempo para o chip aparecer (ou uma 2ª chamada)
    const chip = page.getByText(/\+\d+ XP/);
    if (c.chip) await expect(chip.first()).toBeVisible();
    else await expect(chip).toHaveCount(0);
    await expect(
      page.getByText("Fim de jogo", { exact: false }).first(),
    ).toBeVisible();
    expect(calls()).toBe(1);
    expect(errors).toEqual([]);
  });
}
