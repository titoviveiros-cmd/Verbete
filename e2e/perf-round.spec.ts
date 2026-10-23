import { test, expect, type Page } from "@playwright/test";
import { MARKERS } from "./perf-markers";

// Cronômetro de uma partida real (host + convidado + 2 bots) contra um deploy
// (E2E_BASE_URL) — só com PERF_ROUND=1. Cada tela registra, no relógio da
// máquina, quando cada marco aparece/some (cortina, "Sortear palavra",
// palavras, escrita, embaralhando, votação, revelação, placar) e cada chamada
// ao Supabase (RPC, edge, tabela) com início e fim. Assim dá para separar
// tempo dramático (cortina, animação) de espera de rede e de chamada
// duplicada. Os humanos agem como gente rápida: esperam a cortina sair e
// reagem em 300 ms. No fim o host reseta a sala para o lobby.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.PERF_ROUND,
  "só contra um deploy (E2E_BASE_URL) com PERF_ROUND=1",
);
test.setTimeout(600_000);

const NICK = "Ex: Bia, Zé, Dudu...";
const WRITE = "escreva sua definicao mirabolante...";
const BLUFFS = [
  "pequeno utensilio de ferro usado para moer graos",
  "danca tradicional de roda do litoral nordestino",
];
const REACT_MS = 300;
// PERF_BOTS=0: só humanos — o coordenador é sempre humano (mede o caminho
// das 3 palavras); padrão: 2 bots (mede a escrita e o voto dos bots).
// PERF_HUMANS=1: só o host humano (mesa 1 humano + bots).
const HUMANS = process.env.PERF_HUMANS === "1" ? 1 : 2;
// mesa mínima de 4 (humanos + bots)
const BOTS = Math.max(4 - HUMANS, Number(process.env.PERF_BOTS ?? 2));

type Mark = [number, string, 0 | 1];
type Call = { name: string; start: number; end: number | null; ok: boolean };

function instrument(page: Page, calls: Call[]) {
  const open = new Map<object, Call>();
  const nameOf = (url: string) => {
    const auth = url.match(/\/auth\/v1\/([\w-]+)/);
    if (auth) return `auth:${auth[1]}`;
    const m =
      url.match(/\/rest\/v1\/rpc\/([\w-]+)/) ??
      url.match(/\/functions\/v1\/([\w-]+)/) ??
      url.match(/\/rest\/v1\/([\w-]+)/);
    if (!m) return null;
    if (url.includes("/rpc/")) return `rpc:${m[1]}`;
    if (url.includes("/functions/")) return `edge:${m[1]}`;
    return `tabela:${m[1]}`;
  };
  page.on("request", (r) => {
    const name = nameOf(r.url());
    if (!name) return;
    const c: Call = { name, start: Date.now(), end: null, ok: false };
    open.set(r, c);
    calls.push(c);
  });
  page.on("requestfinished", async (r) => {
    const c = open.get(r);
    if (!c) return;
    c.end = Date.now();
    const res = await r.response().catch(() => null);
    c.ok = !!res && res.status() < 400;
  });
  page.on("requestfailed", (r) => {
    const c = open.get(r);
    if (c) c.end = Date.now();
  });
}

async function marks(page: Page): Promise<Mark[]> {
  return page.evaluate(
    () => (window as unknown as { __perf: { log: Mark[] } }).__perf?.log ?? [],
  );
}

/** Espera o marco LIGAR na tela depois de `since` e devolve o instante. */
async function when(page: Page, key: string, since: number, timeout = 45_000) {
  const hits = async () =>
    (await marks(page)).filter(
      ([t, k, on]) => k === key && on === 1 && t >= since,
    );
  await expect
    .poll(async () => (await hits()).length > 0, {
      timeout,
      intervals: [100],
    })
    .toBe(true);
  return (await hits())[0]![0];
}

/** Espera a cortina de fase sair (ou não ter aparecido) e devolve o instante. */
async function curtainGone(page: Page) {
  await expect
    .poll(
      async () => {
        const log = await marks(page);
        const last = log.filter(([, k]) => k === "cortina").pop();
        return !last || last[2] === 0;
      },
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
  return Date.now();
}

test(`cronômetro de uma partida: host${HUMANS === 2 ? " + convidado" : ""} + ${BOTS} bots`, async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const guestCtx = HUMANS === 2 ? await browser.newContext() : null;
  const host = await hostCtx.newPage();
  const guest = guestCtx ? await guestCtx.newPage() : null;
  const pages = new Map<string, Page>([["host", host]]);
  const calls = new Map<string, Call[]>([["host", []]]);
  if (guest) {
    pages.set("convidado", guest);
    calls.set("convidado", []);
  }
  for (const [name, p] of pages) {
    await p.addInitScript(MARKERS);
    instrument(p, calls.get(name)!);
  }
  const T: Record<string, number> = {};
  const t0 = Date.now();
  let code = "";
  try {
    // 1) criar a sala
    await host.goto("/");
    await expect(async () => {
      await host.getByRole("button", { name: /Criar sala/ }).click();
      await expect(host.getByPlaceholder(NICK)).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 30_000 });
    await host.getByPlaceholder(NICK).fill("Host P");
    T.criar_clique = Date.now();
    // antes da hidratação o clique não faz nada: tenta até a sala abrir
    await expect(async () => {
      if (!/\/room\/\d{4}/.test(host.url()))
        await host
          .getByRole("button", { name: /Criar!/ })
          .click({ timeout: 3_000 });
      await expect(host).toHaveURL(/\/room\/\d{4}/, { timeout: 8_000 });
    }).toPass({ timeout: 45_000 });
    T.criar_lobby = await when(host, "lobby", T.criar_clique, 30_000);
    code = host.url().match(/room\/(\d{4})/)![1];
    console.log(`SALA ${code}`);

    // 2) convidado entra
    if (guest) {
      await guest.goto(`/room/${code}`);
      await expect(guest.getByPlaceholder(NICK)).toBeVisible({
        timeout: 30_000,
      });
      await guest.getByPlaceholder(NICK).fill("Conv P");
      T.entrar_clique = Date.now();
      await guest.getByRole("button", { name: /Entrar na sala/ }).click();
      T.entrar_lobby = await when(guest, "lobby", T.entrar_clique, 30_000);
      await expect(host.getByText("Conv P").first()).toBeVisible({
        timeout: 30_000,
      });
      T.host_ve_convidado = Date.now();
    }

    // 3) dois bots (conta pelo "Jogadores (N/12)" do lobby)
    const seated = async () =>
      Number(
        ((await host.locator("body").innerText()).match(
          /Jogadores \((\d+)\/12\)/i,
        ) ?? [])[1] ?? 0,
      );
    for (let i = 0; i < BOTS; i++) {
      const before = await seated();
      await host.getByRole("button", { name: /\+1 Bot/ }).click();
      await expect.poll(seated, { timeout: 30_000 }).toBeGreaterThan(before);
    }

    let since = Date.now();
    for (let round = 1; round <= 2; round++) {
      const R = `r${round}_`;
      // 4) começar / próxima rodada → escolha
      if (round === 1) {
        since = T[R + "comecar_clique"] = Date.now();
        await host.getByRole("button", { name: /Começar/ }).click();
      }
      T[R + "host_escolhendo"] = await when(host, "escolhendo", since);
      if (guest)
        T[R + "conv_escolhendo"] = await when(guest, "escolhendo", since);

      // 5) coordenador humano: sorteia depois da cortina; bot: escolhe sozinho.
      // Decide pelo estado DEPOIS da transição: o início da partida mostra
      // um coordenador provisório (sorteado no navegador) que o servidor
      // pode trocar — por baixo da transição, o "Sortear" pode piscar.
      for (const [, p] of pages) await curtainGone(p);
      let coord: Page | null = null;
      let coordName = "bot";
      const onNow = (p: Page, key: string) =>
        p.evaluate(
          (k) =>
            !!(
              window as unknown as { __perf?: { on: Record<string, boolean> } }
            ).__perf?.on[k],
          key,
        );
      await expect(async () => {
        coord = null;
        for (const [name, p] of pages) {
          if (await onNow(p, "sortear")) {
            coord = p;
            coordName = name;
          }
        }
        const writing = (await marks(host)).some(
          ([t, k, on]) => k === "escrita" && on && t >= since,
        );
        expect(coord !== null || writing).toBeTruthy();
      }).toPass({ timeout: 60_000 });
      console.log(`RODADA ${round}: coordenador = ${coordName}`);
      if (coord) {
        const c = coord as Page;
        T[R + "sortear_visivel"] = await when(c, "sortear", since);
        T[R + "cortina_saiu"] = await curtainGone(c);
        await c.waitForTimeout(REACT_MS);
        T[R + "sortear_clique"] = Date.now();
        await c
          .getByRole("button", { name: /Sortear palavra/ })
          .click({ force: true });
        T[R + "palavras_visiveis"] = await when(
          c,
          "palavras",
          T[R + "sortear_clique"]!,
          30_000,
        );
        await c.waitForTimeout(REACT_MS);
        T[R + "palavra_clique"] = Date.now();
        await c.locator("button.sticker").first().click({ force: true });
      }
      // o coordenador não escreve (não tem o campo): só quem escreve conta
      const writers = [...pages.entries()].filter(([, p]) => p !== coord);
      for (const [name, w] of writers)
        T[`${R}${name === "host" ? "host" : "conv"}_escrita`] = await when(
          w,
          "escrita",
          since,
        );

      // 6) humanos rápidos: escrevem assim que a cortina sai
      await Promise.all(
        writers.map(async ([name, w], i) => {
          await curtainGone(w);
          await w.waitForTimeout(REACT_MS);
          await w.getByPlaceholder(WRITE).fill(BLUFFS[i % BLUFFS.length]!);
          T[`${R}${name}_envia`] = Date.now();
          await w
            .getByRole("button", { name: /Enviar definição/ })
            .click({ timeout: 5_000 });
        }),
      );
      T[R + "host_embaralhando"] = await when(host, "embaralhando", since);
      if (guest)
        T[R + "conv_embaralhando"] = await when(guest, "embaralhando", since);
      T[R + "host_votacao"] = await when(host, "votacao", since);
      if (guest) T[R + "conv_votacao"] = await when(guest, "votacao", since);

      // 7) votos rápidos (cada humano na primeira cédula habilitada)
      await Promise.all(
        [...pages.entries()].map(async ([name, p]) => {
          await p.waitForTimeout(REACT_MS);
          T[`${R}${name}_vota`] = Date.now();
          await p
            .locator("button:has(.token):not([disabled])")
            .first()
            .click({ force: true });
        }),
      );
      T[R + "host_revelacao"] = await when(host, "revelacao", since);
      if (guest)
        T[R + "conv_revelacao"] = await when(guest, "revelacao", since);

      // 8) a revelação corre sozinha até o placar
      T[R + "host_placar"] = await when(host, "placar", since);
      if (guest) T[R + "conv_placar"] = await when(guest, "placar", since);
      if (round === 2) break;

      // 9) host: próxima rodada assim que a cortina do placar sai
      await curtainGone(host);
      await host.waitForTimeout(REACT_MS);
      since = T[R + "proxima_clique"] = Date.now();
      await host
        .getByRole("button", { name: /Próxima rodada/ })
        .click({ timeout: 10_000 });
    }
  } finally {
    // linha do tempo e chamadas, relativas ao início
    const rel = (t: number) => `${((t - t0) / 1000).toFixed(2)}s`;
    console.log("=== MARCOS (instante relativo)");
    for (const [k, v] of Object.entries(T)) console.log(`${k}: ${rel(v)}`);
    for (const [name, p] of pages) {
      const log = await marks(p).catch(() => [] as Mark[]);
      console.log(`=== TELA ${name}`);
      console.log(
        log.map(([t, k, on]) => `${rel(t)} ${on ? "+" : "-"}${k}`).join(" | "),
      );
    }
    for (const [name, cs] of calls) {
      console.log(`=== CHAMADAS ${name} (${cs.length})`);
      console.log(
        cs
          .map(
            (c) =>
              `${rel(c.start)} ${c.name} ${c.end ? c.end - c.start : "?"}ms${c.ok ? "" : " (falhou)"}`,
          )
          .join("\n"),
      );
    }
    console.log(`=== JSON ${JSON.stringify({ T, t0 })}`);
    if (code) {
      try {
        await host
          .getByRole("button", { name: "Resetar jogo" })
          .click({ timeout: 15_000 });
        await host
          .getByRole("button", { name: /Sim, resetar/ })
          .click({ timeout: 10_000 });
        await expect(
          host.getByRole("button", { name: /Começar|Mín\. 4/ }),
        ).toBeVisible({ timeout: 30_000 });
        console.log(`SALA ${code} RESETADA PARA O LOBBY`);
      } catch (e) {
        console.log(`RESET FALHOU: ${String(e).slice(0, 200)}`);
      }
    }
    await hostCtx.close();
    await guestCtx?.close();
  }
});
