import { expect, test } from "@playwright/test";

// Aceite dos Termos contra o backend REAL (Supabase local do CI): aparelhos
// que NUNCA aceitaram (sem o storageState padrão do config). O host cria a
// sala marcando a caixa; o convidado abre o link de convite, tenta entrar
// SEM aceite (não entra: o host segue sozinho) e, com a caixa, entra.
const NICK = "Ex: Bia, Zé, Dudu...";
const ALERT = "Para continuar, aceite os Termos de Uso.";
const NEVER_ACCEPTED = { cookies: [], origins: [] };

test("aceite real: host cria e convidado só entra com a caixa marcada", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const hostCtx = await browser.newContext({ storageState: NEVER_ACCEPTED });
  const guestCtx = await browser.newContext({ storageState: NEVER_ACCEPTED });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  try {
    await host.goto("/");
    await expect(async () => {
      await host.getByRole("button", { name: /Criar sala/ }).click();
      await expect(host.getByPlaceholder(NICK)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await host.getByPlaceholder(NICK).fill("Host T");
    // sem aceite: fica no formulário
    await host.getByRole("button", { name: /Criar!/ }).click();
    await expect(host.getByText(ALERT)).toBeVisible();
    await expect(host).toHaveURL(/\/$/);
    await host.getByRole("checkbox", { name: /Termos de Uso/ }).check();
    await host.getByRole("button", { name: /Criar!/ }).click();
    await expect(host).toHaveURL(/\/room\/\d{4}/, { timeout: 30_000 });
    const code = host.url().match(/room\/(\d{4})/)![1];

    await guest.goto(`/room/${code}`);
    await expect(guest.getByPlaceholder(NICK)).toBeVisible({ timeout: 30_000 });
    await guest.getByPlaceholder(NICK).fill("Conv T");
    await guest.getByRole("button", { name: /Entrar na sala/ }).click();
    await expect(guest.getByText(ALERT)).toBeVisible();
    // o convidado não entrou: o host não o vê
    await host.waitForTimeout(3_000);
    await expect(host.getByText("Conv T")).toHaveCount(0);

    await guest.getByRole("checkbox", { name: /Termos de Uso/ }).check();
    await guest.getByRole("button", { name: /Entrar na sala/ }).click();
    await expect(host.getByText("Conv T").first()).toBeVisible({
      timeout: 30_000,
    });
    // o aceite ficou no aparelho de cada um (versão + data)
    for (const p of [host, guest]) {
      const rec = await p.evaluate(() =>
        localStorage.getItem("verbete:terms-accepted"),
      );
      expect(JSON.parse(rec ?? "{}").version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  } finally {
    await hostCtx.close();
    await guestCtx.close();
  }
});
