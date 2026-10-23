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

/** Conta DESCARTÁVEL (nunca a do dono) já com sessão; some se a sessão falhar. */
async function disposableAccount() {
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
  try {
    const session = await (
      await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: SB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
    ).json();
    expect(session.access_token, "sessão da conta de teste").toBeTruthy();
    return { uid, session };
  } catch (e) {
    await admin(`/auth/v1/admin/users/${uid}`, { method: "DELETE" });
    throw e;
  }
}

// Red Team da RC 2.1.0 (P0): reports só pelo servidor. Com o token de um
// jogador, ler ou gravar a tabela tem de ser RECUSADO — com o autor resolvido
// no servidor, ler as próprias denúncias revelaria a definição verdadeira na
// votação, e gravar direto forjaria denúncias (migration
// 20261023190000_reports_server_only).
test("reports: token de jogador não lê nem grava (só o servidor)", async () => {
  const { uid, session } = await disposableAccount();
  try {
    const asPlayer = (query: string, init: RequestInit = {}) =>
      fetch(`${SB_URL}/rest/v1/reports${query}`, {
        ...init,
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
      });
    const read = await asPlayer("?select=id&limit=1");
    const write = await asPlayer("", {
      method: "POST",
      body: JSON.stringify({
        definition_text: "sonda do teste e2e",
        offender_player_id: "sonda",
        reporter_user_id: uid,
        reason: "other",
      }),
    });
    console.log(
      `REPORTS com token de jogador: leitura ${read.status}, gravação ${write.status} (esperado 401/403)`,
    );
    expect([401, 403], "leitura recusada").toContain(read.status);
    expect([401, 403], "gravação recusada").toContain(write.status);
  } finally {
    await admin(`/rest/v1/reports?reporter_user_id=eq.${uid}`, {
      method: "DELETE",
    });
    await admin(`/auth/v1/admin/users/${uid}`, { method: "DELETE" });
  }
});

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
  const { uid, session } = await disposableAccount();
  console.log(
    `CONTA DESCARTÁVEL criada (id ${uid.slice(0, 8)}…) — origem ${host}`,
  );
  const calls: string[] = [];
  const reportCalls: Array<{ id: string; body: string }> = [];
  page.on("response", async (r) => {
    if (!r.url().includes("/_serverFn/")) return;
    const post = r.request().postData() ?? "";
    if (post.includes("definitionId"))
      reportCalls.push({
        id:
          post.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)?.[0] ?? "",
        body: await r.text().catch(() => ""),
      });
    const u = new URL(r.url());
    calls.push(
      `${r.request().method()} ${u.origin} → ${r.status()} ${(r.headers()["content-type"] ?? "").split(";")[0]}`,
    );
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("/_serverFn/"))
      calls.push(
        `FALHOU ${r.method()} ${new URL(r.url()).origin} — ${r.failure()?.errorText ?? "?"}`,
      );
  });
  let deleted = false;
  try {
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
      .poll(async () => (await stats()).games_played ?? 0, { timeout: 30_000 })
      .toBe(0);
    await page.reload();
    await page.waitForTimeout(3_000);
    expect((await stats()).games_played ?? 0).toBe(0);
    expect((await stats()).total_score ?? 0).toBe(0);
    console.log(
      "A) ZERAR ESTATÍSTICAS: servidor 3 → zerado (reset_user_stats apaga o registro), continua zerado depois de recarregar — PASS",
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

    // ---------- C) Denúncia: cada cédula vira 1 registro com autor e texto
    // resolvidos no SERVIDOR (na votação a cédula chega sem autor); a
    // verdadeira recebe a MESMA resposta e entra já descartada; reenviar não
    // duplica. Depende da migration 20261023190000 + Worker com
    // report-definition.ts — NATIVE_ACTIONS_REPORT=0 pula este passo.
    if (process.env.NATIVE_ACTIONS_REPORT === "0") {
      console.log("C) DENÚNCIA: PULADA (NATIVE_ACTIONS_REPORT=0)");
    } else {
      const code = await untilVoting(page);
      const saved = () =>
        rows(
          `reports?reporter_user_id=eq.${uid}&select=definition_id,definition_text,offender_player_id,status`,
        );
      const flags = page.getByRole("button", { name: "Reportar definição" });
      const send = async (i: number) => {
        const before = reportCalls.length;
        await flags.nth(i).click({ force: true });
        await page
          .locator("select")
          .filter({ has: page.locator('option[value="spam"]') })
          .selectOption("spam");
        await page.getByRole("button", { name: /^Enviar$/ }).click();
        const thanks = page.getByText(/Denúncia registrada/);
        await expect(thanks).toBeVisible({ timeout: 30_000 });
        await expect(thanks).toBeHidden({ timeout: 10_000 });
        await expect.poll(() => reportCalls.length).toBe(before + 1);
        return reportCalls[before]!;
      };
      const first: Array<{ id: string; body: string }> = [];
      const ballots = await flags.count();
      for (let i = 0; i < ballots; i++) first.push(await send(i));
      const ids = first.map((c) => c.id);
      const defs = await rows(
        `definitions?id=in.(${ids.join(",")})&select=id,is_truth,player_id,text`,
      );
      expect(
        defs.filter((d) => d.is_truth).length,
        "a verdadeira estava entre as cédulas",
      ).toBe(1);
      expect(
        new Set(first.map((c) => c.body)).size,
        "resposta idêntica em todas",
      ).toBe(1);
      await expect
        .poll(async () => (await saved()).length, { timeout: 20_000 })
        .toBe(defs.length);
      for (const r of await saved()) {
        const d = defs.find((x) => x.id === r.definition_id)!;
        expect(r.status).toBe(d.is_truth ? "dismissed" : "pending");
        expect(r.offender_player_id).toBe(d.player_id);
        expect(r.definition_text).toBe(d.text);
      }
      const again = await send(0);
      expect(again.body).toBe(first[0]!.body);
      await page.waitForTimeout(2_000);
      expect((await saved()).length).toBe(defs.length);
      console.log(
        `C) DENÚNCIA (sala ${code}): ${first.length} cédulas → ${defs.length} registros com autor/texto do servidor (verdadeira já descartada, mesma resposta); reenvio não duplica — PASS`,
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
    }

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
