import {
  test,
  expect,
  type Browser,
  type Page,
  type Route,
} from "@playwright/test";

// Corrida no seletor de rodadas (micro-rodada pré-loja). Roda contra o
// Supabase LOCAL do CI (cria salas e começa partidas). O host toca "Rodadas"
// e "5 rod." sem pausa, com a 1ª escrita de configuração ATRASADA de
// propósito — como uma renovação de token ou rede lenta. Antes da fila por
// sala, a 2ª requisição chegava primeiro ao banco e a sala terminava em 10.
// Prova final no servidor: ao começar, host e convidado veem "Rodada 1/N".
const SUPA_URL = process.env.VITE_SUPABASE_URL ?? "";
const SUPA_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
test.skip(
  !!process.env.E2E_BASE_URL || !/127\.0\.0\.1|localhost/.test(SUPA_URL),
  "só contra o Supabase local do CI",
);
test.setTimeout(120_000);

const NICK = "Ex: Bia, Zé, Dudu...";

async function hostAndGuest(browser: Browser) {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  await host.goto("/");
  await expect(async () => {
    await host.getByRole("button", { name: /Criar sala/ }).click();
    await expect(host.getByPlaceholder(NICK)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await host.getByPlaceholder(NICK).fill("Host W");
  await host.getByRole("button", { name: /Criar!/ }).click();
  await expect(host).toHaveURL(/\/room\/\d{4}/, { timeout: 30_000 });
  const code = host.url().match(/room\/(\d{4})/)![1];
  await guest.goto(`/room/${code}`);
  await expect(guest.getByPlaceholder(NICK)).toBeVisible({ timeout: 30_000 });
  await guest.getByPlaceholder(NICK).fill("Conv W");
  await guest.getByRole("button", { name: /Entrar na sala/ }).click();
  await expect(host.getByText("Conv W").first()).toBeVisible({
    timeout: 30_000,
  });
  const close = async () => {
    await hostCtx.close();
    await guestCtx.close();
  };
  return { host, guest, code, close };
}

/** Atrasa a 1ª escrita de configuração do host (ms fixos, ou até `delay`
 *  resolver) e conta envios e respostas. */
async function delayFirstConfigWrite(
  page: Page,
  delay: number | Promise<void>,
) {
  const sent: string[] = [];
  let answered = 0;
  await page.route(
    "**/rest/v1/rpc/host_update_room_config",
    async (route: Route) => {
      const i = sent.length;
      sent.push(route.request().postData() ?? "");
      if (i === 0)
        await (typeof delay === "number"
          ? new Promise((r) => setTimeout(r, delay))
          : delay);
      await route.continue();
    },
  );
  page.on("response", (r) => {
    if (r.url().includes("/rpc/host_update_room_config")) answered++;
  });
  /** Espera todas as escritas responderem (pelo menos `min`) e nada novo sair. */
  const settle = async (min: number) => {
    await expect
      .poll(() => sent.length >= min && answered === sent.length, {
        timeout: 15_000,
      })
      .toBe(true);
    await page.waitForTimeout(800);
    expect(answered, "escrita nova depois do fim da fila").toBe(sent.length);
  };
  return { sent, settle };
}

/** Grava cada texto que o botão "Rodadas" mostra na tela do host. */
async function recordRoundsLabel(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __labels: string[] };
    w.__labels = [];
    const read = () => {
      const b = Array.from(document.querySelectorAll("button")).find((x) =>
        /número fixo/.test(x.textContent ?? ""),
      );
      const t = (b?.textContent ?? "").replace("número fixo", "").trim();
      if (t && t !== w.__labels[w.__labels.length - 1]) w.__labels.push(t);
    };
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    read();
  });
  return () =>
    page.evaluate(() => (window as unknown as { __labels: string[] }).__labels);
}

async function startAndExpectTotal(host: Page, guest: Page, total: number) {
  // mínimo de 4 participantes (2º playtest 2026-10-20): completa com bots
  const encher = host.getByRole("button", { name: /Encher até 4/ });
  if (await encher.isVisible().catch(() => false)) {
    await encher.click();
    await expect(host.getByText("Jogadores (4/12)")).toBeVisible({
      timeout: 25_000,
    });
  }
  await host.getByRole("button", { name: /Começar/ }).click();
  for (const p of [host, guest]) {
    await expect(p.getByText(`/${total}`, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  }
}

test("Rodadas → 5 rod. sem pausa, com a 1ª escrita atrasada: servidor, host e convidado ficam em 5", async ({
  browser,
}) => {
  const { host, guest, close } = await hostAndGuest(browser);
  try {
    const net = await delayFirstConfigWrite(host, 1_500);
    const labels = await recordRoundsLabel(host);
    await host.getByRole("button", { name: /^Rodadas/ }).click();
    await host.getByRole("button", { name: /^5 rod\.$/ }).click();
    await net.settle(2);
    await host.waitForTimeout(1_500); // ecos atrasados do realtime
    const seen = await labels();
    const first5 = seen.indexOf("5 rodadas");
    expect(first5, `rótulos: ${JSON.stringify(seen)}`).toBeGreaterThan(-1);
    expect(
      seen.slice(first5),
      `a tela do host voltou para outro valor: ${JSON.stringify(seen)}`,
    ).toEqual(["5 rodadas"]);
    await startAndExpectTotal(host, guest, 5);
  } finally {
    await close();
  }
});

test("só Rodadas termina em 10", async ({ browser }) => {
  const { host, guest, close } = await hostAndGuest(browser);
  try {
    await host.getByRole("button", { name: /^Rodadas/ }).click();
    await expect(
      host.getByRole("button", { name: /^10 rodadas/ }),
    ).toBeVisible();
    await startAndExpectTotal(host, guest, 10);
  } finally {
    await close();
  }
});

test("toques múltiplos rápidos: no máximo 2 escritas e vale o último (5)", async ({
  browser,
}) => {
  const { host, guest, close } = await hostAndGuest(browser);
  try {
    // A 1ª escrita fica em voo até o ÚLTIMO toque: em qualquer máquina os 5
    // toques acontecem com ela pendente. Com 1,5 s fixos, um runner lento
    // tocava depois da resposta e saíam 4 escritas (CI 40247645490, retry).
    let tapsDone!: () => void;
    const taps = new Promise<void>((r) => (tapsDone = r));
    const net = await delayFirstConfigWrite(host, taps);
    await host.getByRole("button", { name: /^Rodadas/ }).click();
    for (const n of [5, 10, 15, 20, 5]) {
      await host
        .getByRole("button", { name: new RegExp(`^${n} rod\\.$`) })
        .click();
    }
    tapsDone();
    await net.settle(2);
    expect(net.sent.length, JSON.stringify(net.sent)).toBeLessThanOrEqual(2);
    await expect(
      host.getByRole("button", { name: /^5 rodadas/ }),
    ).toBeVisible();
    await startAndExpectTotal(host, guest, 5);
  } finally {
    await close();
  }
});

test("convidado não altera a configuração (nem pela API)", async ({
  browser,
}) => {
  const { host, guest, code, close } = await hostAndGuest(browser);
  try {
    // Na tela do convidado não há seletor de fim de partida.
    await expect(guest.getByText("Como termina a partida?")).toHaveCount(0);
    await expect(guest.getByRole("button", { name: /rod\.$/ })).toHaveCount(0);

    // Pela API, com a sessão do convidado: como ele mesmo e fingindo ser o host.
    const results = await guest.evaluate(
      async ({ url, key, code }) => {
        const tokenKey = Object.keys(localStorage).find((k) =>
          /^sb-.*-auth-token$/.test(k),
        );
        const token = tokenKey
          ? (
              JSON.parse(localStorage.getItem(tokenKey)!) as {
                access_token: string;
              }
            ).access_token
          : "";
        const call = (fn: string, body: unknown) =>
          fetch(`${url}/rest/v1/rpc/${fn}`, {
            method: "POST",
            headers: {
              apikey: key,
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          }).then((r) => r.json());
        const state = (await call("get_room_state", { p_code: code })) as {
          room: { id: string; host_id: string };
        };
        const me = localStorage.getItem("verbete:player-id") ?? "";
        const patch = { win_condition: "rounds", win_target: 20 };
        const asGuest = await call("host_update_room_config", {
          p_room_id: state.room.id,
          p_actor_id: me,
          p_patch: patch,
        });
        const asHost = await call("host_update_room_config", {
          p_room_id: state.room.id,
          p_actor_id: state.room.host_id,
          p_patch: patch,
        });
        const after = (await call("get_room_state", { p_code: code })) as {
          room: { win_condition: string; win_target: number };
        };
        return { asGuest, asHost, after: after.room };
      },
      { url: SUPA_URL, key: SUPA_KEY, code },
    );
    expect(results.asGuest, JSON.stringify(results)).toMatchObject({
      ok: false,
    });
    expect(results.asHost, JSON.stringify(results)).toMatchObject({
      ok: false,
    });
    expect(results.after.win_target).not.toBe(20);

    // O host segue mandando: a escolha dele vale para os dois.
    await host.getByRole("button", { name: /^Rodadas/ }).click();
    await host.getByRole("button", { name: /^5 rod\.$/ }).click();
    await startAndExpectTotal(host, guest, 5);
  } finally {
    await close();
  }
});
