// Embaralhamento (prévia, 2026-10-22): o convidado que recebia a fase
// atrasado pelo tempo real e a votação quase junto com o host via o
// "Embaralhando as cédulas" por ~2,3 s. Agora a votação só toma o lugar dele
// depois de 2,5 s à vista NESTE aparelho. Medido no relógio da própria
// página (o Playwright vê a tela com atraso numa página ocupada).
import { expect, test } from "@playwright/test";
import { installSupabaseMock, type MockBackend } from "./supabase-mock";
import { ROOM_CODE, ROOM_ID, roomBackend, roomStorage } from "./fixtures";

test("convidado: votação que chega cedo espera o embaralhamento ficar 2,5 s", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const backend = roomBackend("writing", { guest: true }) as MockBackend;
  const room = () =>
    (backend.tables["rooms"] as Record<string, unknown>[]).find(
      (r) => r.id === ROOM_ID,
    )!;
  await page.setViewportSize({ width: 390, height: 844 });
  await installSupabaseMock(page, backend);
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("writing"));
  await page.addInitScript(() => {
    const w = window as unknown as { __emb: { on?: number; off?: number } };
    w.__emb = {};
    setInterval(() => {
      const on = /embaralhando as cédulas/i.test(
        document.body?.innerText ?? "",
      );
      if (on && w.__emb.on === undefined) w.__emb.on = Date.now();
      if (!on && w.__emb.on !== undefined && w.__emb.off === undefined)
        w.__emb.off = Date.now();
    }, 40);
  });
  await page.goto(`/room/${ROOM_CODE}`);
  // a sala carregou (tela de escrita) antes de virar a fase
  await expect(
    page.getByPlaceholder("escreva sua definicao mirabolante..."),
  ).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(600);
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
  const emb = () =>
    page.evaluate(
      () =>
        (window as unknown as { __emb: { on?: number; off?: number } }).__emb,
    );
  await flip({ status: "shuffling" });
  await expect
    .poll(async () => (await emb()).on, { timeout: 5_000 })
    .toBeTruthy();
  // a votação chega logo depois (o host abriu e o tempo real foi rápido)
  await page.waitForTimeout(500);
  await flip({
    status: "voting",
    round_phase_ends_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await expect
    .poll(async () => (await emb()).off, { timeout: 6_000 })
    .toBeTruthy();
  const { on, off } = await emb();
  const visible = off! - on!;
  console.log(`embaralhamento à vista por ${visible} ms (relógio da página)`);
  expect(
    visible,
    "a votação não cortou o embaralhamento",
  ).toBeGreaterThanOrEqual(2_450);
  expect(visible, "sem espera a mais").toBeLessThanOrEqual(3_200);
  await expect(page.getByText(/Qual é o significado de/i).first()).toBeVisible({
    timeout: 5_000,
  });
});
