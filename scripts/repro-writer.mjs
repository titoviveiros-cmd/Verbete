// Repro instrumentada: 2 navegadores até a escrita; captura console e a
// RESPOSTA do submit_definition para ver por que a definição não persiste.
import { chromium } from "@playwright/test";

const base = "http://localhost:5173";
const NICK = "Ex: Bia, Zé, Dudu...";
const browser = await chromium.launch();
const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
const host = await ctxA.newPage();
const guest = await ctxB.newPage();

for (const [name, page] of [["host", host], ["guest", guest]]) {
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type()))
      console.log(`[${name} console.${m.type()}]`, m.text().slice(0, 300));
  });
  page.on("response", async (r) => {
    if (r.url().includes("submit_definition") || r.url().includes("insert_truth")) {
      const body = await r.text().catch(() => "?");
      console.log(`[${name} rpc] ${r.url().split("/rpc/")[1] ?? r.url()} -> ${r.status()} ${body.slice(0, 200)}`);
    }
  });
}

await host.goto(base + "/");
for (let i = 0; i < 12; i++) {
  await host.getByRole("button", { name: /Criar sala/ }).click().catch(() => {});
  if (await host.getByPlaceholder(NICK).isVisible().catch(() => false)) break;
  await host.waitForTimeout(600);
}
await host.getByPlaceholder(NICK).fill("E2E Host");
await host.getByRole("button", { name: /Criar!/ }).click();
await host.waitForURL(/\/room\/\d{4}/, { timeout: 20000 });
const code = host.url().match(/room\/(\d{4})/)[1];
console.log("sala:", code);

await guest.goto(`${base}/room/${code}`);
await guest.getByPlaceholder(NICK).waitFor({ timeout: 20000 });
await guest.getByPlaceholder(NICK).fill("E2E Guest");
await guest.getByRole("button", { name: /Entrar na sala/ }).click();
await host.getByText("E2E Guest").first().waitFor({ timeout: 25000 });
await host.getByRole("button", { name: /Começar/ }).click();

// Força o cenário das falhas: coordenador = CONVIDADO, escritor = HOST.
const pg = (await import("pg")).default;
const db = new pg.Client({
  connectionString: process.env.DB_URL,
  ssl: /supabase\.co/.test(process.env.DB_URL ?? "")
    ? { rejectUnauthorized: false }
    : false,
});
await db.connect();
await host.waitForTimeout(2500); // start_game aplicar
const { rows: [guestRow] } = await db.query(
  `SELECT p.id, p.room_id FROM public.players p JOIN public.rooms r ON r.id = p.room_id
    WHERE r.code = $1 AND p.nickname = 'E2E Guest'`, [code]);
await db.query(`UPDATE public.rooms SET current_coordinator = $1 WHERE id = $2`,
  [guestRow.id, guestRow.room_id]);
await db.end();
console.log("coordenador FORÇADO: guest — escritor: host");
const coord = guest;
const writer = host;
await coord.reload();
await writer.reload();
await coord.getByRole("button", { name: /Sortear palavra/ }).click();
await coord.locator("button.sticker").first().click({ timeout: 20000 });

const ta = writer.getByPlaceholder("escreva sua definicao mirabolante...");
await ta.waitFor({ timeout: 30000 });
try {
  await ta.fill("definicao mirabolante do teste multiplayer", {
    timeout: 8000,
  });
  console.log("fill OK");
} catch (e) {
  console.log("FILL FALHOU:", String(e).slice(0, 500));
}
try {
  await writer
    .getByRole("button", { name: /Enviar definição/ })
    .click({ timeout: 8000 });
  console.log("clicou em enviar — aguardando resposta do RPC…");
} catch (e) {
  console.log("CLICK FALHOU:", String(e).slice(0, 500));
}
await writer.waitForTimeout(6000);
const enviada = await writer.getByText("Definição enviada").isVisible().catch(() => false);
console.log("UI mostra 'Definição enviada!':", enviada);
const toast = await writer.locator("[data-sonner-toast]").innerText().catch(() => "(sem toast)");
console.log("toast:", toast.slice(0, 200));
await browser.close();
