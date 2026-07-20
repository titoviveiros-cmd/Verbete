import { test, expect } from "@playwright/test";

// Smoke E2E: fluxo real de criação de sala — home → formulário → lobby.
// Exercita createRoom (RPC create_room_with_host + claim de identidade)
// e a navegação para /room/$code com o jogador renderizado no lobby.
test("host cria sala e chega ao lobby", async ({ page }) => {
  await page.goto("/");

  // SSR: o HTML chega antes da hidratação — clicar cedo demais cai no vazio.
  // Repete o clique até o formulário existir.
  const nickInput = page.getByPlaceholder("Ex: Bia, Zé, Dudu...");
  await expect(async () => {
    await page.getByRole("button", { name: /Criar sala/ }).click();
    await expect(nickInput).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  await nickInput.fill("E2E Host");
  await page.getByRole("button", { name: /Criar!/ }).click();

  // Navegou para a sala (código de 4 dígitos na URL)
  await expect(page).toHaveURL(/\/room\/\d{4}/, { timeout: 20_000 });

  // Lobby renderiza o próprio jogador
  await expect(page.getByText("E2E Host").first()).toBeVisible({
    timeout: 20_000,
  });
});
