// Repro do Desafio Diário em PRODUÇÃO com usuário de teste:
// login por senha → /daily → palpite → captura resposta do server-fn.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "https://jogo.verbete.workers.dev";
const SUPA = process.env.SUPA_URL;
const SERVICE = process.env.SERVICE_KEY;
const EMAIL = "e2e-daily@verbete.test";
const PASS = "senha-e2e-123";

// garante o usuário de teste (confirmado)
const create = await fetch(`${SUPA}/auth/v1/admin/users`, {
  method: "POST",
  headers: {
    apikey: SERVICE,
    Authorization: `Bearer ${SERVICE}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email: EMAIL, password: PASS, email_confirm: true }),
});
console.log("criar usuário teste:", create.status, (await create.text()).slice(0, 120));

const browser = await chromium.launch({
  args: process.env.E2E_RESOLVE
    ? [`--host-resolver-rules=${process.env.E2E_RESOLVE}`]
    : [],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 240));
});
page.on("response", async (r) => {
  const u = r.url();
  if (/serverFn|_server|daily/i.test(u) && !/\.js|\.css|\.png/.test(u)) {
    const body = await r.text().catch(() => "?");
    console.log(`[resp] ${r.status()} ${u.slice(0, 110)}\n       ${body.slice(0, 260)}`);
  }
});

await page.goto(`${BASE}/login`);
await page.waitForTimeout(2500);
await page.locator('input[type="email"]').fill(EMAIL);
await page.locator('input[type="password"]').fill(PASS);
await page.getByRole("button", { name: /^Entrar$/ }).click();
await page.waitForTimeout(3500);
console.log("pós-login url:", page.url());

await page.goto(`${BASE}/daily`);
await page.waitForTimeout(3500);
const ta = page.locator("textarea");
if (await ta.isVisible().catch(() => false)) {
  await ta.fill("lamina pequena e afiada de cortar papel");
  await page.getByRole("button", { name: /Enviar palpite/ }).click();
  await page.waitForTimeout(9000);
  console.log("texto pós-envio:", (await page.locator("body").innerText()).slice(0, 380).replace(/\n+/g, " | "));
} else {
  console.log("textarea não visível — página:", (await page.locator("body").innerText()).slice(0, 300).replace(/\n+/g, " | "));
}
await browser.close();
