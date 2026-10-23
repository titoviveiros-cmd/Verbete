import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

// Mínimo oficial de 4 participantes (migration 20261020220000) num deploy —
// só com MIN_E2E=1. O host cria a sala e vai somando bots: com 2 e 3 o botão
// fica travado E o servidor recusa start_game (chamada direta, com a sessão
// do próprio host); com 4 o botão libera (a partida não é iniciada: não gasta
// IA). Confere também o tema claro padrão e o avatar sem bolinhas de cor.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.MIN_E2E,
  "só contra um deploy (E2E_BASE_URL) com MIN_E2E=1",
);
test.setTimeout(180_000);

// URL e chave PÚBLICA (publishable) do Supabase, as mesmas do bundle.
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^VITE_SUPABASE_(URL|PUBLISHABLE_KEY)=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);
const NICK = "Ex: Bia, Zé, Dudu...";

test("mínimo de 4: com 2 e 3 o servidor recusa; com 4 o botão libera", async ({
  page,
}) => {
  let roomId = "";
  page.on("request", (r) => {
    const m = r.url().match(/\/rest\/v1\/rooms\?.*id=eq\.([0-9a-f-]{36})/);
    if (m) roomId = m[1]!;
  });
  await page.goto("/");
  const light = await page.evaluate(() =>
    document.documentElement.classList.contains("light"),
  );
  console.log(`TEMA CLARO PADRÃO: ${light ? "SIM" : "NÃO"}`);
  expect.soft(light).toBe(true);
  await expect(async () => {
    await page.getByRole("button", { name: /Criar sala/ }).click();
    await expect(page.getByPlaceholder(NICK)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const dots = await page.getByLabel(/Escolher cor/).count();
  console.log(`BOLINHAS DE COR NA NOVA SALA: ${dots}`);
  expect.soft(dots).toBe(0);
  await page.getByPlaceholder(NICK).fill("Host Min");
  await expect(async () => {
    if (!/\/room\/\d{4}/.test(page.url()))
      await page
        .getByRole("button", { name: /Criar!/ })
        .click({ timeout: 3_000 });
    await expect(page).toHaveURL(/\/room\/\d{4}/, { timeout: 8_000 });
  }).toPass({ timeout: 45_000 });
  const code = page.url().match(/room\/(\d{4})/)![1]!;
  console.log(`SALA ${code}`);
  await expect.poll(() => roomId, { timeout: 20_000 }).not.toBe("");

  const seated = async () =>
    Number(
      ((await page.locator("body").innerText()).match(
        /Jogadores \((\d+)\/12\)/i,
      ) ?? [])[1] ?? 0,
    );
  const startRpc = () =>
    page.evaluate(
      async ({ url, key, id }) => {
        const k = Object.keys(localStorage).find((x) =>
          /^sb-.*-auth-token$/.test(x),
        );
        const tok = k ? JSON.parse(localStorage.getItem(k)!).access_token : "";
        const r = await fetch(`${url}/rest/v1/rpc/start_game`, {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: `Bearer ${tok}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p_room_id: id }),
        });
        return { status: r.status, body: await r.json() };
      },
      {
        url: env.VITE_SUPABASE_URL!,
        key: env.VITE_SUPABASE_PUBLISHABLE_KEY!,
        id: roomId,
      },
    );

  for (const want of [2, 3, 4]) {
    const before = await seated();
    await page.getByRole("button", { name: /\+1 Bot/ }).click();
    await expect.poll(seated, { timeout: 30_000 }).toBeGreaterThan(before);
    expect(await seated()).toBe(want);
    if (want < 4) {
      const btn = page.getByRole("button", { name: /Mín\. 4/ });
      await expect(btn).toBeDisabled({ timeout: 10_000 });
      // o bot aparece na tela na hora (otimista); espera o servidor gravá-lo
      // antes de conferir a recusa (start_game só lê e recusa abaixo de 4)
      let res = await startRpc();
      for (let i = 0; i < 20 && res.body?.players !== want; i++) {
        await page.waitForTimeout(500);
        res = await startRpc();
      }
      console.log(
        `${want} PARTICIPANTES: botão "${await btn.innerText()}" travado; servidor → ${JSON.stringify(res.body)}`,
      );
      expect(res.body).toMatchObject({
        ok: false,
        reason: "min_players",
        players: want,
        min: 4,
      });
    } else {
      const go = page.getByRole("button", { name: /Começar/ });
      await expect(go).toBeEnabled({ timeout: 10_000 });
      console.log(`4 PARTICIPANTES: botão "${await go.innerText()}" liberado`);
    }
  }
});
