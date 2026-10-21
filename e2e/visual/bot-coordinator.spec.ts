// Coordenador BOT (playtest 2026-10-21): a tela "Coordenador da rodada —
// 🤖 Fulano está escolhendo a palavra…" sumia sem ser lida (o host escolhia
// em ~1 s, ainda sob a cortina). Agora: a escolha sai só depois da cortina
// + ~2,6 s de tela legível; só o HOST escolhe (os demais cobrem a falta dele
// bem depois e sem otimismo); uma escolha por rodada. Banco simulado que
// acompanha cada virada (o poll não desfaz a fase do teste).
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock, type MockBackend } from "./supabase-mock";
import { ROOM_CODE, ROOM_ID, roomBackend, roomStorage } from "./fixtures";

const BOT = "bot_tio";
const WORDS = [
  { id: "w_contumaz", word: "contumaz", category: "adjetivo", rarity: 3 },
  { id: "w_farfalhar", word: "farfalhar", category: "verbo", rarity: 2 },
  { id: "w_diafano", word: "diáfano", category: "qualidade", rarity: 3 },
];

async function setup(page: Page, guest: boolean) {
  const backend = roomBackend("lobby", { guest }) as MockBackend;
  backend.rpc["get_random_word_prompts"] = WORDS;
  const picks: number[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/rest/v1/rpc/choose_word")) picks.push(Date.now());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await installSupabaseMock(page, backend);
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("lobby"));
  await page.goto(`/room/${ROOM_CODE}`);
  await expect(page.getByText("Jogadores (4/12)")).toBeVisible({
    timeout: 25_000,
  });
  await page.waitForTimeout(600);
  const room = () =>
    (backend.tables["rooms"] as Record<string, unknown>[]).find(
      (r) => r.id === ROOM_ID,
    )!;
  // A rodada vira "Escolha da Palavra" com o bot de coordenador — no banco
  // simulado e no app ao mesmo tempo (como chega pelo realtime).
  const toChoosing = async (round: number) => {
    const patch = {
      status: "choosing",
      current_round: round,
      current_coordinator: BOT,
      current_word_id: null,
      round_phase_ends_at: new Date(Date.now() + 60_000).toISOString(),
    };
    Object.assign(room(), patch);
    await page.evaluate(
      ([roomId, p]) =>
        window.dispatchEvent(
          new CustomEvent("room:optimistic-update", {
            detail: { roomId, patch: p },
          }),
        ),
      [ROOM_ID, patch] as const,
    );
    return Date.now();
  };
  const toWriting = () =>
    Object.assign(room(), { status: "writing", current_word_id: WORDS[0]!.id });
  return { picks, toChoosing, toWriting };
}

/** O "🤖 TioBlefe está escolhendo a palavra…" está na tela e tocável (não
 *  coberto pela cortina nem pela barreira de toque)? */
const waitingVisible = (page: Page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll("p")].find((p) =>
      /TioBlefe está escolhendo a palavra/.test(p.textContent ?? ""),
    );
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    return !!hit && el.contains(hit);
  });

test("host: a tela do coordenador bot fica ~2,6–3 s legível e a escolha sai uma vez por rodada", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { picks, toChoosing, toWriting } = await setup(page, false);
  for (const round of [1, 2, 3]) {
    const before = picks.length;
    const t0 = await toChoosing(round);
    await expect(
      page.locator('[data-phase-announcer="choosing"] h2'),
    ).toHaveText("Escolha da Palavra");
    // 3,4 s depois da virada a cortina já saiu: a tela do bot está à vista
    await page.waitForTimeout(Math.max(0, t0 + 3_400 - Date.now()));
    expect(
      await waitingVisible(page),
      `rodada ${round}: tela do bot visível`,
    ).toBe(true);
    expect(picks.length, `rodada ${round}: não escolheu sob a cortina`).toBe(
      before,
    );
    await expect.poll(() => picks.length, { timeout: 9_000 }).toBe(before + 1);
    const dt = picks[before]! - t0;
    const legivel = dt - 3_250; // a cortina inteira (2,8 s + 0,45 s de saída)
    console.log(
      `rodada ${round}: escolha em ${dt} ms → tela legível ${legivel} ms`,
    );
    expect(legivel, `rodada ${round}: tempo de leitura`).toBeGreaterThanOrEqual(
      2_500,
    );
    expect(legivel, `rodada ${round}: sem atraso extra`).toBeLessThanOrEqual(
      3_300,
    );
    toWriting();
    await page.waitForTimeout(2_000);
    expect(picks.length, `rodada ${round}: uma escolha só`).toBe(before + 1);
  }
});

test("convidado: não escolhe no lugar do host antes da hora e não mostra palavra otimista", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { picks, toChoosing } = await setup(page, true);
  const t0 = await toChoosing(1);
  await page.waitForTimeout(8_500);
  expect(picks.length, "convidado esperou o host (≥ 9,9 s)").toBe(0);
  await expect.poll(() => picks.length, { timeout: 5_000 }).toBe(1);
  console.log(`convidado cobriu a falta do host em ${picks[0]! - t0} ms`);
  expect(picks[0]! - t0).toBeGreaterThanOrEqual(9_800);
  // sem otimismo: segue mostrando a tela do bot até o banco confirmar
  await page.waitForTimeout(400);
  expect(await waitingVisible(page), "sem palavra otimista do convidado").toBe(
    true,
  );
});
