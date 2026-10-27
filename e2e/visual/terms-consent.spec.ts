// Aceite dos Termos antes de criar conteúdo (Google Play, política de UGC).
// Começa de um aparelho que NUNCA aceitou (sem o storageState padrão do
// config) e cobre todo caminho de entrada: Criar sala, Entrar com código,
// deep link ?join=, convite /room/CODE, volta do host sem registro, volta
// após remoção, escrita da definição, criar conta, Google e nome do perfil.
// Em cada um: tentar enviar SEM aceite não chama o backend; com a caixa
// marcada, chama. Backend simulado (supabase-mock): nada sai da máquina.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import {
  installSupabaseMock,
  type MockBackend,
  type MockLog,
} from "./supabase-mock";
import {
  ME,
  ROOM_CODE,
  USER_ID,
  homeBackend,
  roomBackend,
  roomStorage,
} from "./fixtures";
import { TERMS_VERSION } from "../../src/lib/terms-consent";

test.use({ storageState: { cookies: [], origins: [] } });

const ALERT = "Para continuar, aceite os Termos de Uso.";
const KEY = "verbete:terms-accepted";
const AXE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

const consent = (page: Page) =>
  page.getByRole("checkbox", { name: /Li e aceito os Termos de Uso/ });
const calls = (log: MockLog, rpc: string) =>
  log.calls.filter((c) => c === `POST /rest/v1/rpc/${rpc}`).length;

async function seed(page: Page, entries: Record<string, string>) {
  await page.addInitScript((e) => {
    for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
  }, entries);
}
const stored = (page: Page) =>
  page.evaluate((k) => localStorage.getItem(k), KEY);

/**
 * O app abre uma sessão ANÔNIMA no boot (__root → ensureAnonSession). O mock
 * compartilhado responde com uma sessão não anônima, e o /login mandaria
 * para o Perfil. Aqui, só o cadastro anônimo (sem e-mail) volta anônimo,
 * como no Supabase de verdade; o cadastro com e-mail segue para o mock.
 */
async function anonymousBoot(page: Page) {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  await page.route(
    (u) => u.pathname.endsWith("/auth/v1/signup"),
    async (route) => {
      if ((route.request().postData() ?? "").includes("@"))
        return route.fallback();
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const id = "00000000-0000-4000-8000-00000000a0a0";
      const user = {
        id,
        aud: "authenticated",
        role: "authenticated",
        is_anonymous: true,
        app_metadata: { provider: "anonymous", providers: ["anonymous"] },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      };
      const jwt = [
        b64({ alg: "HS256", typ: "JWT" }),
        b64({
          sub: id,
          role: "authenticated",
          aud: "authenticated",
          exp,
          is_anonymous: true,
        }),
        "assinatura-falsa",
      ].join(".");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          access_token: jwt,
          refresh_token: "refresh-falso",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: exp,
          user,
        }),
      });
    },
  );
}

/** Abre o formulário da Home (SSR: repete o toque até hidratar). */
async function openHomeForm(page: Page, button: RegExp) {
  const nick = page.getByPlaceholder("Ex: Bia, Zé, Dudu...");
  await expect(async () => {
    await page.getByRole("button", { name: button }).click();
    await expect(nick).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return nick;
}

/** Tenta enviar sem aceite → aviso e nenhuma chamada; marca → chama. */
async function blockedThenAllowed(
  page: Page,
  log: MockLog,
  rpc: string,
  submit: () => Promise<void>,
) {
  await expect(consent(page)).toBeVisible();
  await expect(consent(page)).not.toBeChecked();
  await submit();
  await expect(page.getByText(ALERT)).toBeVisible();
  await expect(consent(page)).toBeFocused();
  await page.waitForTimeout(400); // nada pendente sai depois do aviso
  expect(calls(log, rpc), `${rpc} sem aceite`).toBe(0);
  expect(await stored(page), "aceite gravado sem a caixa").toBeNull();
  await consent(page).check();
  await expect(page.getByText(ALERT)).toBeHidden();
  await submit();
  await expect
    .poll(() => calls(log, rpc), { timeout: 10_000 })
    .toBeGreaterThan(0);
  const rec = JSON.parse((await stored(page)) ?? "{}");
  expect(rec.version).toBe(TERMS_VERSION);
  expect(Number.isNaN(Date.parse(rec.at))).toBe(false);
}

test("Criar sala: sem aceite não cria; com a caixa cria e grava versão + data", async ({
  page,
}) => {
  const log = await installSupabaseMock(page, homeBackend(false));
  await page.goto("/");
  const nick = await openHomeForm(page, /Criar sala/);
  await nick.fill("Bia");
  await blockedThenAllowed(page, log, "create_room_with_host", () =>
    page.getByRole("button", { name: /Criar!/ }).click(),
  );
});

test("Entrar com código: sem aceite não entra; com a caixa entra", async ({
  page,
}) => {
  const log = await installSupabaseMock(page, roomBackend("lobby"));
  await seed(page, { "verbete:player-id": "p_visita9" });
  await page.goto("/");
  const nick = await openHomeForm(page, /Entrar com código/);
  await page.getByPlaceholder("0000").fill(ROOM_CODE);
  await nick.fill("Bia");
  await blockedThenAllowed(page, log, "rejoin_room", () =>
    page.getByRole("button", { name: /^Entrar$/ }).click(),
  );
});

test("deep link /?join=CODE (convite e App Links): mesma exigência", async ({
  page,
}) => {
  const log = await installSupabaseMock(page, roomBackend("lobby"));
  await seed(page, { "verbete:player-id": "p_visita9" });
  await page.goto(`/?join=${ROOM_CODE}`);
  const nick = page.getByPlaceholder("Ex: Bia, Zé, Dudu...");
  await expect(nick).toBeVisible({ timeout: 25_000 });
  await expect(page.getByPlaceholder("0000")).toHaveValue(ROOM_CODE);
  await nick.fill("Bia");
  await blockedThenAllowed(page, log, "rejoin_room", () =>
    page.getByRole("button", { name: /^Entrar$/ }).click(),
  );
});

test("convite /room/CODE (JoinFlow): visitante só entra com o aceite", async ({
  page,
}) => {
  const log = await installSupabaseMock(page, roomBackend("lobby"));
  await seed(page, { "verbete:player-id": "p_visita9" });
  await page.goto(`/room/${ROOM_CODE}`);
  const nick = page.getByPlaceholder("Ex: Bia, Zé, Dudu...");
  await expect(nick).toBeVisible({ timeout: 25_000 });
  await nick.fill("Visita");
  await blockedThenAllowed(page, log, "rejoin_room", () =>
    page.getByRole("button", { name: /Entrar na sala/ }).click(),
  );
});

/** Sala em que o host (Bia) perdeu o registro de jogador. */
function hostWithoutPlayer(): MockBackend {
  const b = roomBackend("lobby");
  b.tables["players"] = b.tables["players"]!.filter((p) => p.id !== ME);
  const st = b.rpc["get_room_state"] as unknown as {
    players: Array<{ id: string }>;
  };
  st.players = st.players.filter((p) => p.id !== ME);
  return b;
}

test("host sem registro e SEM aceite: não volta sozinho — passa pela caixa", async ({
  page,
}) => {
  const log = await installSupabaseMock(page, hostWithoutPlayer());
  await seed(page, roomStorage("lobby"));
  await page.goto(`/room/${ROOM_CODE}`);
  await expect(
    page.getByRole("button", { name: /Entrar na sala/ }),
  ).toBeVisible({
    timeout: 25_000,
  });
  await page.waitForTimeout(1_500);
  expect(calls(log, "rejoin_room"), "volta automática sem aceite").toBe(0);
  await blockedThenAllowed(page, log, "rejoin_room", () =>
    page.getByRole("button", { name: /Entrar na sala/ }).click(),
  );
});

test("host sem registro COM aceite: volta sozinho, sem caixa (como antes)", async ({
  page,
}) => {
  const log = await installSupabaseMock(page, hostWithoutPlayer());
  await seed(page, {
    ...roomStorage("lobby"),
    [KEY]: JSON.stringify({
      version: TERMS_VERSION,
      at: "2026-10-26T00:00:00Z",
    }),
  });
  await page.goto(`/room/${ROOM_CODE}`);
  await expect
    .poll(() => calls(log, "rejoin_room"), { timeout: 25_000 })
    .toBeGreaterThan(0);
  await expect(consent(page)).toHaveCount(0);
});

test("escrita: jogador já na sala sem aceite (entrou antes / revanche) só envia com a caixa", async ({
  page,
}) => {
  const log = await installSupabaseMock(page, roomBackend("writing"));
  await seed(page, roomStorage("writing"));
  await page.goto(`/room/${ROOM_CODE}`);
  const box = page.getByPlaceholder("escreva sua definicao mirabolante...");
  await expect(box).toBeVisible({ timeout: 25_000 });
  await box.fill("barulho de festa animada");
  await blockedThenAllowed(page, log, "submit_definition", () =>
    page
      .getByRole("button", { name: /Enviar definição/ })
      .last()
      .click(),
  );
});

test("removido da partida e SEM aceite: 'Voltar para a partida' só com a caixa", async ({
  page,
}) => {
  const backend = roomBackend("writing");
  const log = await installSupabaseMock(page, backend);
  await seed(page, roomStorage("writing"));
  await page.goto(`/room/${ROOM_CODE}`);
  await expect(
    page.getByPlaceholder("escreva sua definicao mirabolante..."),
  ).toBeVisible({
    timeout: 25_000,
  });
  // o servidor remove a Bia (3 prazos perdidos): o poll de jogadores percebe
  const bia = backend.tables["players"]!.find((p) => p.id === ME)!;
  bia["kicked_at"] = new Date().toISOString();
  await expect(page.getByText("Você foi removido da partida")).toBeVisible({
    timeout: 15_000,
  });
  await blockedThenAllowed(page, log, "rejoin_room", () =>
    page.getByRole("button", { name: /Voltar para a partida/ }).click(),
  );
});

test("Entrar com Google sem aceite não sai para o Google; com a caixa sai", async ({
  page,
}) => {
  await installSupabaseMock(page, homeBackend(false));
  await anonymousBoot(page);
  await page.goto("/login");
  const google = page.getByRole("button", { name: /Entrar com Google/ });
  await expect(google).toBeVisible({ timeout: 25_000 });
  const authorize: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/auth/v1/authorize")) authorize.push(r.url());
  });
  await expect(async () => {
    await google.click();
    await expect(page.getByText(ALERT)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.waitForTimeout(500);
  expect(authorize, "foi ao Google sem aceite").toEqual([]);
  await consent(page).check();
  await Promise.all([
    page.waitForRequest((r) => r.url().includes("/auth/v1/authorize"), {
      timeout: 10_000,
    }),
    google.click(),
  ]);
});

test("Criar conta (nome no ranking) sem aceite não cadastra; com a caixa cadastra", async ({
  page,
}) => {
  await installSupabaseMock(page, homeBackend(false));
  await anonymousBoot(page);
  await page.goto("/login");
  await expect(async () => {
    await page.getByRole("button", { name: /Cadastre-se/ }).click();
    await expect(page.getByPlaceholder("Senha")).toBeVisible({
      timeout: 1_000,
    });
    await expect(
      page.getByRole("button", { name: /^Criar conta$/ }),
    ).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 25_000 });
  const signups: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/auth/v1/signup"))
      signups.push(r.postData() ?? "");
  });
  const form = page.locator("form");
  for (const input of await form.locator("input").all()) {
    const t = await input.getAttribute("type");
    const ph = (await input.getAttribute("placeholder")) ?? "";
    if (t === "email") await input.fill("bia@exemplo.invalid");
    else if (t === "password") await input.fill("senha-de-teste");
    else if (/nome|apelido/i.test(ph)) await input.fill("Bia");
  }
  await page.getByRole("button", { name: /^Criar conta$/ }).click();
  await expect(page.getByText(ALERT)).toBeVisible();
  await page.waitForTimeout(500);
  expect(signups.filter((b) => b.includes("bia@exemplo.invalid"))).toEqual([]);
  await consent(page).check();
  await page.getByRole("button", { name: /^Criar conta$/ }).click();
  await expect
    .poll(
      () => signups.filter((b) => b.includes("bia@exemplo.invalid")).length,
      { timeout: 10_000 },
    )
    .toBe(1);
});

test("Perfil: mudar o nome (visível no ranking) sem aceite não salva", async ({
  page,
}) => {
  const backend = homeBackend(true);
  backend.tables["profiles"] = [
    { user_id: USER_ID, display_name: "Bia", avatar: "🦊", color: "#FF5C8A" },
  ];
  await installSupabaseMock(page, backend);
  const patches: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/rest/v1/profiles"))
      patches.push(r.postData() ?? "");
  });
  await page.goto("/profile");
  await page
    .getByRole("heading", { name: "Bia" })
    .first()
    .click({ timeout: 25_000 });
  const input = page.locator("input[maxlength='24']");
  await input.fill("Bia Nova");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText(ALERT)).toBeVisible();
  await page.waitForTimeout(400);
  expect(patches, "salvou o nome sem aceite").toEqual([]);
  await consent(page).check();
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(1);
  expect(patches[0]).toContain("Bia Nova");
});

test("persistência: aceitou uma vez → recarregar e reabrir o app não pedem de novo", async ({
  page,
  browser,
}) => {
  const log = await installSupabaseMock(page, homeBackend(false));
  await page.goto("/");
  const nick = await openHomeForm(page, /Criar sala/);
  await nick.fill("Bia");
  await consent(page).check();
  await page.getByRole("button", { name: /Criar!/ }).click();
  await expect
    .poll(() => calls(log, "create_room_with_host"))
    .toBeGreaterThan(0);
  // recarregar
  await page.goto("/");
  await openHomeForm(page, /Criar sala/);
  await expect(consent(page)).toHaveCount(0);
  // fechar e reabrir (novo contexto com o mesmo armazenamento do aparelho)
  const ctx = await browser.newContext({
    storageState: await page.context().storageState(),
  });
  const again = await ctx.newPage();
  await installSupabaseMock(again, homeBackend(false));
  await again.goto("/");
  await openHomeForm(again, /Entrar com código/);
  await expect(consent(again)).toHaveCount(0);
  await ctx.close();
});

test("revisão dos Termos (versão nova) pede o aceite de novo", async ({
  page,
}) => {
  await installSupabaseMock(page, homeBackend(false));
  await seed(page, {
    [KEY]: JSON.stringify({
      version: "2025-01-01",
      at: "2025-01-01T00:00:00Z",
    }),
  });
  await page.goto("/");
  await openHomeForm(page, /Criar sala/);
  await expect(consent(page)).toBeVisible();
  await expect(consent(page)).not.toBeChecked();
});

test("acessibilidade (WCAG 2.1 AA) da caixa, normal e com o aviso", async ({
  page,
}) => {
  await installSupabaseMock(page, homeBackend(false));
  await page.goto("/");
  const nick = await openHomeForm(page, /Criar sala/);
  await nick.fill("Bia");
  await page.addScriptTag({ content: AXE });
  const audit = () =>
    page.evaluate(async () => {
      const box = document.querySelector("[data-testid='terms-consent']")!;
      const region = box.closest("label")!.parentElement!;
      const w = window as unknown as {
        axe: {
          run: (
            ctx: Element,
            o: object,
          ) => Promise<{ violations: Array<{ id: string; nodes: unknown[] }> }>;
        };
      };
      const r = await w.axe.run(region, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
    });
  expect(await audit(), "caixa normal").toEqual([]);
  await page.getByRole("button", { name: /Criar!/ }).click();
  await expect(page.getByText(ALERT)).toBeVisible();
  expect(await audit(), "caixa com aviso").toEqual([]);
  // alvo de toque: a caixa e o texto clicável têm ≥ 24 px de altura (WCAG 2.5.8)
  const label = await page
    .locator("label:has([data-testid='terms-consent'])")
    .boundingBox();
  expect(label!.height).toBeGreaterThanOrEqual(24);
});

for (const [w, h] of [
  [320, 568],
  [667, 375],
] as const) {
  test(`caixa em ${w}x${h}: inteira na tela, sem cobrir os botões`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: w, height: h });
    await installSupabaseMock(page, homeBackend(false));
    await page.goto("/");
    await openHomeForm(page, /Criar sala/);
    await consent(page).scrollIntoViewIfNeeded();
    const geo = await page.evaluate(() => {
      const label = document
        .querySelector("[data-testid='terms-consent']")!
        .closest("label")!
        .getBoundingClientRect();
      const hits = [...document.querySelectorAll("button")]
        .map((b) => ({
          t: (b.textContent ?? "").trim(),
          r: b.getBoundingClientRect(),
        }))
        .filter(
          ({ r }) =>
            r.width > 0 &&
            r.left < label.right &&
            r.right > label.left &&
            r.top < label.bottom &&
            r.bottom > label.top,
        )
        .map(({ t }) => t);
      return {
        left: label.left,
        right: label.right,
        width: window.innerWidth,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        hits,
      };
    });
    expect(geo.left).toBeGreaterThanOrEqual(0);
    expect(geo.right).toBeLessThanOrEqual(geo.width);
    expect(geo.overflow, "rolagem horizontal").toBeLessThanOrEqual(1);
    expect(geo.hits, "caixa sobre botão").toEqual([]);
  });
}
