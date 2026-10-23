// Coordenador BOT na 1ª rodada (playtest 2026-10-21): o "Começar" mostrava um
// coordenador PROVISÓRIO sorteado no aparelho; ~1,2 s depois o servidor
// confirmava outro e a escolha do bot recomeçava a conta — a tela do
// coordenador ficava ~5,1 s. Agora: a sala só vira com o coordenador do
// servidor, a conta é ancorada uma vez por rodada e a tela fica ~2,65 s.
// O banco simulado acompanha cada virada; o servidor responde com atraso.
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { ROOM_CODE, ROOM_ID, roomBackend, roomStorage } from "./fixtures";

const BOT = "bot_tio";
const HUMAN = "p_ze004";
const CURTAIN_OUT_MS = 2800 + 450; // cortina na tela + saída (PhaseAnnouncer)
const WORDS = [
  { id: "w_contumaz", word: "contumaz", category: "adjetivo", rarity: 3 },
  { id: "w_farfalhar", word: "farfalhar", category: "verbo", rarity: 2 },
  { id: "w_diafano", word: "diáfano", category: "qualidade", rarity: 3 },
];

async function setup(page: Page) {
  const backend = roomBackend("lobby");
  backend.rpc["get_random_word_prompts"] = WORDS;
  const room = () =>
    (backend.tables["rooms"] as Record<string, unknown>[]).find(
      (r) => r.id === ROOM_ID,
    )!;
  const picks: number[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/rest/v1/rpc/choose_word")) picks.push(Date.now());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await installSupabaseMock(page, backend);
  // Na página: quando a cortina aparece e se "Sortear palavra" (coordenador
  // humano provisório) chegou a existir na tela.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __curtainAt?: number;
      __sawSortear?: boolean;
    };
    new MutationObserver(() => {
      if (
        w.__curtainAt === undefined &&
        document.querySelector('[data-phase-announcer="choosing"]')
      )
        w.__curtainAt = Date.now();
      if (
        [...document.querySelectorAll("button")].some((b) =>
          /Sortear palavra/.test(b.textContent ?? ""),
        )
      )
        w.__sawSortear = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("lobby"));
  await page.goto(`/room/${ROOM_CODE}`);
  await expect(page.getByText("Jogadores (4/12)")).toBeVisible({
    timeout: 25_000,
  });
  await page.waitForTimeout(600);
  const probe = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __curtainAt?: number;
        __sawSortear?: boolean;
      };
      return { curtainAt: w.__curtainAt ?? null, sawSortear: !!w.__sawSortear };
    });
  return { backend, room, picks, probe };
}

test("1ª rodada pelo Começar: só o coordenador do servidor, tela do bot ~2,5–3 s, uma escolha", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { room, picks, probe } = await setup(page);
  // servidor demora 900 ms e sorteia o BOT (o app antigo já teria mostrado
  // um coordenador seu antes disso)
  await page.route("**/rest/v1/rpc/start_game", async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    Object.assign(room(), {
      status: "choosing",
      current_round: 1,
      current_coordinator: BOT,
      current_word_id: null,
      round_phase_ends_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
      body: JSON.stringify({ ok: true, coordinator: BOT }),
    });
  });
  const clickAt = Date.now();
  await page.getByRole("button", { name: /Começar/ }).click();
  await expect(page.locator('[data-phase-announcer="choosing"] h2')).toHaveText(
    "Escolha da Palavra",
  );
  await expect.poll(() => picks.length, { timeout: 12_000 }).toBe(1);
  const { curtainAt, sawSortear } = await probe();
  expect(curtainAt, "cortina registrada").not.toBeNull();
  console.log(
    `servidor respondeu e a cortina abriu em ${curtainAt! - clickAt} ms; escolha em ${picks[0]! - curtainAt!} ms → tela legível ${picks[0]! - curtainAt! - CURTAIN_OUT_MS} ms`,
  );
  expect(
    curtainAt! - clickAt,
    "sem virada antes do servidor",
  ).toBeGreaterThanOrEqual(850);
  expect(sawSortear, "nenhum coordenador provisório na tela").toBe(false);
  const legivel = picks[0]! - curtainAt! - CURTAIN_OUT_MS;
  expect(legivel).toBeGreaterThanOrEqual(2_500);
  expect(legivel).toBeLessThanOrEqual(3_000);
  Object.assign(room(), { status: "writing", current_word_id: WORDS[0]!.id });
  await page.waitForTimeout(2_000);
  expect(picks.length, "uma escolha só").toBe(1);
});

test("troca provisório → autoritativo NÃO reinicia a conta da escolha do bot", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { room, picks, probe } = await setup(page);
  const flip = async (patch: Record<string, unknown>) => {
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
  };
  // a sala vira com um coordenador humano (provisório)…
  await flip({
    status: "choosing",
    current_round: 1,
    current_coordinator: HUMAN,
    current_word_id: null,
    round_phase_ends_at: new Date(Date.now() + 60_000).toISOString(),
  });
  // …e 1,2 s depois chega o autoritativo: o bot
  await page.waitForTimeout(1_200);
  await flip({ current_coordinator: BOT });
  await expect.poll(() => picks.length, { timeout: 12_000 }).toBe(1);
  const { curtainAt } = await probe();
  const legivel = picks[0]! - curtainAt! - CURTAIN_OUT_MS;
  console.log(
    `escolha ${picks[0]! - curtainAt!} ms após a virada → tela legível ${legivel} ms`,
  );
  expect(legivel, "a troca não somou ~1,2 s à tela").toBeLessThanOrEqual(3_000);
  expect(legivel).toBeGreaterThanOrEqual(2_500);
});
