import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

// Escolha de avatar em telas Android estreitas (2.1.1): só os animais (nenhum
// "Escolher cor") e nada passa da borda do card nem da tela — Nova sala,
// Entrar com código, JoinFlow da sala e, com SUPABASE_SERVICE_ROLE_KEY,
// Perfil (conta descartável). Contra o site ou o bundle nativo
// (https://localhost). Só com AVATAR_E2E=1.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.AVATAR_E2E,
  "só com E2E_BASE_URL e AVATAR_E2E=1",
);
test.setTimeout(420_000);

const WIDTHS = [320, 360, 412];
const BASE = process.env.E2E_BASE_URL!;

const phone = (browser: Browser, width: number) =>
  browser.newContext({
    baseURL: BASE,
    viewport: { width, height: 780 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  });

async function measure(page: Page) {
  await expect(page.getByLabel(/^Escolher avatar/).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(600); // animação de entrada do formulário
  return page.evaluate(() => {
    const btns = [
      ...document.querySelectorAll<HTMLElement>(
        '[aria-label^="Escolher avatar"]',
      ),
    ];
    const grid = btns[0]!.parentElement!;
    const card = grid.parentElement!;
    const c = card.getBoundingClientRect();
    const outside = btns.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.left < c.left - 0.5 || r.right > c.right + 0.5;
    }).length;
    return {
      buttons: btns.length,
      colors: document.querySelectorAll('[aria-label^="Escolher cor"]').length,
      outside,
      cardOffScreen: c.left < -0.5 || c.right > window.innerWidth + 0.5,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      gridOverflow: grid.scrollWidth - grid.clientWidth,
      minButton: Math.round(
        Math.min(...btns.map((b) => b.getBoundingClientRect().width)),
      ),
    };
  });
}

function check(
  where: string,
  width: number,
  m: Awaited<ReturnType<typeof measure>>,
) {
  console.log(`${where} @${width}px: ${JSON.stringify(m)}`);
  expect(m.buttons, `${where}@${width}: animais`).toBe(16);
  expect(m.colors, `${where}@${width}: sem cor`).toBe(0);
  expect(m.outside, `${where}@${width}: nada fora do card`).toBe(0);
  expect(m.cardOffScreen, `${where}@${width}: card na tela`).toBe(false);
  expect(
    m.pageOverflow,
    `${where}@${width}: sem rolagem lateral`,
  ).toBeLessThanOrEqual(0);
  expect(
    m.gridOverflow,
    `${where}@${width}: grade sem transbordo`,
  ).toBeLessThanOrEqual(0);
  expect(
    m.minButton,
    `${where}@${width}: alvo de toque`,
  ).toBeGreaterThanOrEqual(24);
}

async function createRoom(browser: Browser) {
  const ctx = await phone(browser, 412);
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: /Criar sala/ }).click();
  await page.getByPlaceholder("Ex: Bia, Zé, Dudu...").fill("Teste Avatar");
  await expect(async () => {
    if (!/\/room\/\d{4}/.test(page.url()))
      await page
        .getByRole("button", { name: /Criar!/ })
        .click({ timeout: 3_000 });
    await expect(page).toHaveURL(/\/room\/\d{4}/, { timeout: 8_000 });
  }).toPass({ timeout: 45_000 });
  return { ctx, code: page.url().match(/room\/(\d{4})/)![1]! };
}

test("avatar: só animais e nada vaza do card em 320/360/412 px", async ({
  browser,
}) => {
  const host = await createRoom(browser);
  try {
    for (const width of WIDTHS) {
      const ctx: BrowserContext = await phone(browser, width);
      const page = await ctx.newPage();
      await page.goto("/");
      await page.getByRole("button", { name: /Criar sala/ }).click();
      check("Nova sala", width, await measure(page));
      await page.getByRole("button", { name: /Voltar/ }).click();
      await page.getByRole("button", { name: /Entrar com código/ }).click();
      check("Entrar com código", width, await measure(page));
      await page.screenshot({
        path: test.info().outputPath(`entrar-${width}.png`),
      });
      await page.goto(`/room/${host.code}`);
      check("JoinFlow da sala", width, await measure(page));
      await ctx.close();
    }
  } finally {
    await host.ctx.close();
  }
});

// Perfil: precisa de conta — descartável, criada e apagada aqui.
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
const SB_URL =
  process.env.VITE_SUPABASE_URL ?? fromFile.VITE_SUPABASE_URL ?? "";
const SB_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  fromFile.VITE_SUPABASE_PUBLISHABLE_KEY ??
  "";
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

test("Perfil: editor de avatar só com animais, sem vazar, em 320/360/412 px", async ({
  browser,
}) => {
  test.skip(!SR || !SB_URL, "precisa de SUPABASE_SERVICE_ROLE_KEY");
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${SB_URL}${path}`, {
      ...init,
      headers: {
        apikey: SR,
        Authorization: `Bearer ${SR}`,
        "Content-Type": "application/json",
      },
    });
  const email = `verbete-teste-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const uid =
    (
      (await (
        await admin("/auth/v1/admin/users", {
          method: "POST",
          body: JSON.stringify({ email, password, email_confirm: true }),
        })
      ).json()) as { id?: string }
    ).id ?? "";
  expect(uid).not.toBe("");
  try {
    const session = await (
      await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: SB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
    ).json();
    const ref = new URL(SB_URL).hostname.split(".")[0];
    for (const width of WIDTHS) {
      const ctx = await phone(browser, width);
      await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [
        `sb-${ref}-auth-token`,
        JSON.stringify(session),
      ] as const);
      const page = await ctx.newPage();
      await page.goto("/profile");
      await page.getByRole("button", { name: "Alterar avatar" }).click();
      check("Perfil", width, await measure(page));
      await ctx.close();
    }
  } finally {
    await admin(`/auth/v1/admin/users/${uid}`, { method: "DELETE" });
  }
});
