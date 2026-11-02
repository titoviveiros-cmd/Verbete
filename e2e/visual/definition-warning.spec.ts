// 2.1.4 — definição sem asteriscos (sala 5873: "ciceronear" virou "***ar").
// Usar a palavra da rodada (mesmo disfarçada) não é mais mascarado: o envio
// para, o texto fica e aparece o aviso discreto acima do contador. Se o
// servidor recusar (reveals_word), o mesmo aviso. Texto legítimo segue igual.
// Backend simulado (supabase-mock): nada sai da máquina.
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage } from "./fixtures";

const WARN = "⚠️ Não vale usar a palavra da rodada!";

async function openWriting(page: Page, submitReply: unknown = { ok: true }) {
  const backend = roomBackend("writing");
  backend.rpc.submit_definition = submitReply as never;
  await installSupabaseMock(page, backend);
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("writing"));
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/rest/v1/rpc/submit_definition"))
      sent.push(r.postData() ?? "");
  });
  await page.goto(`/room/${ROOM_CODE}`);
  const box = page.getByPlaceholder("escreva sua definicao mirabolante...");
  await expect(box).toBeVisible({ timeout: 25_000 });
  return { box, sent };
}

const send = (page: Page) =>
  page.getByRole("button", { name: "✍️ Enviar definição" }).click();

test("palavra da rodada (inteira ou disfarçada): aviso, texto intacto, nada enviado, sem asterisco", async ({
  page,
}) => {
  const { box, sent } = await openWriting(page);
  for (const text of ["um rapapé daqueles", "pura r.a.p.a.p.e de corte"]) {
    await box.fill(text);
    await send(page);
    const alert = page.getByTestId("definition-warning");
    await expect(alert).toHaveText(WARN);
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(box).toHaveValue(text);
    await expect(page.getByText("*", { exact: false })).toHaveCount(0);
  }
  expect(sent).toHaveLength(0);
  // reescrever apaga o aviso
  await box.fill("cerimonia exagerada de mesuras");
  await expect(page.getByTestId("definition-warning")).toHaveCount(0);
});

test("servidor recusa (reveals_word): mesmo aviso e o texto continua para corrigir", async ({
  page,
}) => {
  const { box, sent } = await openWriting(page, {
    ok: false,
    reason: "reveals_word",
  });
  await box.fill("cerimonia exagerada de mesuras");
  await send(page);
  await expect(page.getByTestId("definition-warning")).toHaveText(WARN);
  await expect(box).toHaveValue("cerimonia exagerada de mesuras");
  expect(sent).toHaveLength(1);
});

test("texto legítimo vai como foi escrito (sem máscara)", async ({ page }) => {
  const { box, sent } = await openWriting(page);
  await box.fill("cerimonia exagerada de mesuras");
  await send(page);
  await expect.poll(() => sent.length).toBe(1);
  expect(JSON.parse(sent[0]!).p_text).toBe("cerimonia exagerada de mesuras");
  await expect(page.getByTestId("definition-warning")).toHaveCount(0);
});
