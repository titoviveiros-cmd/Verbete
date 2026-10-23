import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

// As 4 ações que dependem de função de servidor (P1 da RC Android 2.1.0), de
// ponta a ponta, com uma conta DESCARTÁVEL criada aqui (nunca a do dono):
// zerar estatísticas, tentativa do Desafio diário, denúncia e — por último —
// excluir a conta. Tudo conferido no SERVIDOR, não só na tela. Roda contra o
// site (E2E_BASE_URL=https://jogo.verbete.workers.dev) ou contra o bundle
// NATIVO servido em https://localhost (a mesma origem do WebView do
// Capacitor). Só com NATIVE_ACTIONS_E2E=1 e SUPABASE_SERVICE_ROLE_KEY no
// ambiente — a chave nunca é impressa.
test.skip(
  !process.env.E2E_BASE_URL ||
    !process.env.NATIVE_ACTIONS_E2E ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "só com E2E_BASE_URL, NATIVE_ACTIONS_E2E=1 e SUPABASE_SERVICE_ROLE_KEY",
);
test.use({ ignoreHTTPSErrors: true });
test.setTimeout(600_000);

const fromFile: Record<string, string> = existsSync(".env")
  ? Object.fromEntries(
      readFileSync(".env", "utf8")
        .split(/\r?\n/)
        .filter((l) => /^VITE_SUPABASE_(URL|PUBLISHABLE_KEY)=/.test(l))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
        }),
    )
  : {};
const SB_URL = process.env.VITE_SUPABASE_URL ?? fromFile.VITE_SUPABASE_URL!;
const SB_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  fromFile.VITE_SUPABASE_PUBLISHABLE_KEY!;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const REF = SB_URL ? new URL(SB_URL).hostname.split(".")[0] : "";
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}${path}`, {
    ...init,
    headers: {
      apikey: SR,
      Authorization: `Bearer ${SR}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });
const rows = async (q: string) =>
  (await (await admin(`/rest/v1/${q}`)).json()) as Array<
    Record<string, unknown>
  >;

/** Joga até a votação (host = conta de teste + 3 bots) e devolve a página. */
async function untilVoting(page: Page) {
  await page.goto("/");
  await expect(async () => {
    await page.getByRole("button", { name: /Criar sala/ }).click();
    await expect(page.getByPlaceholder("Ex: Bia, Zé, Dudu...")).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await page.getByPlaceholder("Ex: Bia, Zé, Dudu...").fill("Teste Nativo");
  await expect(async () => {
    if (!/\/room\/\d{4}/.test(page.url()))
      await page
        .getByRole("button", { name: /Criar!/ })
        .click({ timeout: 3_000 });
    await expect(page).toHaveURL(/\/room\/\d{4}/, { timeout: 8_000 });
  }).toPass({ timeout: 45_000 });
  const code = page.url().match(/room\/(\d{4})/)![1]!;
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: /\+1 Bot/ }).click();
    await page.waitForTimeout(1_500);
  }
  await expect(page.getByRole("button", { name: /Começar/ })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: /Começar/ }).click();
  const ballots = page.locator("button:has(.token)");
  await expect(async () => {
    const sortear = page.getByRole("button", { name: /Sortear palavra/ });
    if (await sortear.isVisible().catch(() => false)) {
      await sortear.click({ force: true, timeout: 3_000 });
      await page
        .locator("button.sticker")
        .first()
        .click({ force: true, timeout: 15_000 });
    }
    const field = page.getByPlaceholder("escreva sua definicao mirabolante...");
    if (await field.isVisible().catch(() => false)) {
      await field.fill("utensilio de teste para conferir a denuncia");
      await page
        .getByRole("button", { name: /Enviar definição/ })
        .click({ timeout: 3_000 })
        .catch(() => {});
    }
    expect(await ballots.first().isVisible()).toBe(true);
  }).toPass({ timeout: 240_000, intervals: [2_000] });
  return code;
}

test("as 4 ações de servidor com conta descartável — conferidas no servidor", async ({
  page,
}) => {
  const host = new URL(process.env.E2E_BASE_URL!).origin;
  const email = `verbete-teste-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const created = (await (
    await admin("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
  ).json()) as { id?: string };
  const uid = created.id ?? "";
  expect(uid, "conta descartável criada").not.toBe("");
  console.log(
    `CONTA DESCARTÁVEL criada (id ${uid.slice(0, 8)}…) — origem ${host}`,
  );
  const calls: string[] = [];
  page.on("response", (r) => {
    if (!r.url().includes("/_serverFn/")) return;
    const u = new URL(r.url());
    calls.push(
      `${r.request().method()} ${u.origin} → ${r.status()} ${(r.headers()["content-type"] ?? "").split(";")[0]}`,
    );
  });
  let deleted = false;
  try {
    const session = await (
      await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: SB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
    ).json();
    expect(session.access_token, "sessão da conta de teste").toBeTruthy();
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
      `sb-${REF}-auth-token`,
      JSON.stringify(session),
    ] as const);
    await expect
      .poll(async () => (await rows(`profiles?user_id=eq.${uid}`)).length, {
        timeout: 20_000,
      })
      .toBe(1);
    const displayName = String(
      (await rows(`profiles?user_id=eq.${uid}&select=display_name`))[0]!
        .display_name,
    );

    // ---------- A) Zerar estatísticas: estatística NÃO zero → zero no servidor
    await admin("/rest/v1/user_stats", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id: uid,
        games_played: 3,
        games_won: 1,
        total_score: 42,
        best_match_score: 20,
      }),
    });
    const stats = async () =>
      (
        await rows(
          `user_stats?user_id=eq.${uid}&select=games_played,total_score`,
        )
      )[0] ?? {};
    expect((await stats()).games_played).toBe(3);
    await page.goto("/profile");
    await page
      .getByRole("button", { name: /Zerar minhas estatísticas/ })
      .click();
    await page.getByRole("button", { name: /Zerar tudo/ }).click();
    await expect
      .poll(async () => (await stats()).games_played, { timeout: 30_000 })
      .toBe(0);
    await page.reload();
    await page.waitForTimeout(3_000);
    expect((await stats()).games_played).toBe(0);
    expect((await stats()).total_score).toBe(0);
    console.log(
      "A) ZERAR ESTATÍSTICAS: servidor 3 → 0, continua 0 depois de recarregar — PASS",
    );

    // ---------- B) Desafio diário: tentativa registrada exatamente uma vez
    const attempts = async () =>
      (await rows(`daily_attempts?user_id=eq.${uid}&select=id`)).length;
    await page.goto("/daily");
    const guess = page.getByPlaceholder(/Arrisque sua definição/);
    await expect(guess).toBeVisible({ timeout: 30_000 });
    await guess.fill("instrumento de teste automatizado");
    await page.getByRole("button", { name: /Enviar palpite/ }).click();
    await expect.poll(attempts, { timeout: 60_000 }).toBe(1);
    await page.reload();
    await page.waitForTimeout(4_000);
    expect(await attempts()).toBe(1);
    console.log(
      "B) DESAFIO DIÁRIO: 1 tentativa no servidor, continua 1 depois de recarregar — PASS",
    );

    // ---------- C) Denúncia: registrada no servidor e sem duplicar no retry
    const code = await untilVoting(page);
    const reports = async () =>
      (await rows(`reports?reporter_user_id=eq.${uid}&select=id,definition_id`))
        .length;
    const flag = page
      .getByRole("button", { name: "Reportar definição" })
      .first();
    for (let i = 0; i < 2; i++) {
      await flag.click({ force: true });
      await page.locator('input[value="spam"]').check({ force: true });
      await page.getByRole("button", { name: /^Enviar$/ }).click();
      await expect(page.getByText(/Denúncia registrada/)).toBeVisible({
        timeout: 30_000,
      });
      await page.waitForTimeout(1_500);
    }
    await expect.poll(reports, { timeout: 20_000 }).toBe(1);
    console.log(
      `C) DENÚNCIA (sala ${code}): 1 registro no servidor depois de 2 envios — PASS`,
    );
    await admin(`/rest/v1/reports?reporter_user_id=eq.${uid}`, {
      method: "DELETE",
    });
    await page
      .getByRole("button", { name: "Resetar jogo" })
      .click({ timeout: 10_000 })
      .then(() =>
        page
          .getByRole("button", { name: /Sim, resetar/ })
          .click({ timeout: 10_000 }),
      )
      .catch(() => {});

    // ---------- D) Excluir conta: só sai depois de o servidor confirmar
    await page.goto("/profile");
    await page.getByRole("button", { name: /Excluir minha conta/ }).click();
    await page.getByPlaceholder(displayName).fill(displayName);
    await page.getByRole("button", { name: /Excluir tudo/ }).click();
    await expect
      .poll(async () => (await admin(`/auth/v1/admin/users/${uid}`)).status, {
        timeout: 30_000,
      })
      .toBe(404);
    deleted = true;
    expect((await rows(`profiles?user_id=eq.${uid}`)).length).toBe(0);
    await expect(page).toHaveURL(new RegExp(`^${host}/?$`), {
      timeout: 15_000,
    });
    console.log(
      "D) EXCLUIR CONTA: usuário some do servidor (404) e o perfil some; só então volta ao início — PASS",
    );
  } finally {
    if (!deleted)
      await admin(`/auth/v1/admin/users/${uid}`, { method: "DELETE" });
    console.log(`CHAMADAS DE FUNÇÃO DE SERVIDOR:\n  ${calls.join("\n  ")}`);
  }
});
