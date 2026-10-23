import { test, expect, type Page } from "@playwright/test";

// Sincronização entre aparelhos num deploy (E2E_BASE_URL) — só com
// SYNC_E2E=1. Dois humanos + 2 bots. Cada página anota, no próprio relógio,
// quando cada contador/tela muda ("X/Y enviaram", "X/Y votaram", fases,
// "Jogadores (N/12)"); o Node anota quando a ação do OUTRO aparelho foi
// confirmada pelo servidor (resposta da RPC). Delta = quando o outro viu −
// quando a ação foi confirmada. Também mede o "🤖 gerar definição
// automática": toque → campo preenchido. Na rodada SYNC_SLOW_ROUND (padrão
// 3) o host fica com rede lenta (400 ms de latência). No fim reseta a sala.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.SYNC_E2E,
  "só contra um deploy (E2E_BASE_URL) com SYNC_E2E=1",
);
test.setTimeout(1_200_000);

const NICK = "Ex: Bia, Zé, Dudu...";
const WRITE = "escreva sua definicao mirabolante...";
const ROUNDS = Number(process.env.SYNC_ROUNDS ?? 3);
const SLOW = Number(process.env.SYNC_SLOW_ROUND ?? 3);
const BLUFF = {
  host: "utensilio antigo de cozinha usado para ralar milho",
  convidado: "danca de roda tipica das festas do interior",
};
type Ev = [number, string, string];

const SAMPLER = () => {
  const w = window as unknown as { __sync: Ev[]; __on: Record<string, string> };
  w.__sync = [];
  w.__on = {};
  const probes: Record<string, () => string> = {
    enviaram: () =>
      (document.body.innerText.match(/(\d+)\/(\d+) enviaram/i) ?? [""])[0],
    votaram: () =>
      (document.body.innerText.match(/(\d+)\/(\d+) votaram/i) ?? [""])[0],
    jogadores: () =>
      (document.body.innerText.match(/Jogadores \((\d+)\/12\)/i) ?? [""])[0],
    fase: () => {
      const t = document.body.innerText;
      if (/Como cada um pontuou|Pontuação por equipe/i.test(t)) return "placar";
      if (/A definição verdadeira/i.test(t)) return "revelacao";
      if (
        /Qual é o significado de/i.test(t) &&
        document.querySelector("button .token")
      )
        return "votacao";
      if (/embaralhando as cédulas/i.test(t)) return "embaralhando";
      // a tela do COORDENADOR na escrita não tem "X/Y enviaram" — sem isto o
      // medidor casava o início da escrita com a tela de saída (falso 6 s)
      if (/enviaram|Você é o coordenador/i.test(t)) return "escrita";
      if (/Coordenador da rodada/i.test(t)) return "escolha";
      return "";
    },
  };
  setInterval(() => {
    if (!document.body) return;
    for (const [k, f] of Object.entries(probes)) {
      let v = "";
      try {
        v = f();
      } catch {
        v = "";
      }
      if (v !== (w.__on[k] ?? "")) {
        w.__on[k] = v;
        w.__sync.push([Date.now(), k, v]);
      }
    }
  }, 25);
};

test("sincronização entre 2 aparelhos + definição automática", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  const pages = { host, convidado: guest } as const;
  const acts: Array<{ who: string; what: string; at: number }> = [];
  for (const [who, p] of Object.entries(pages)) {
    await p.addInitScript(SAMPLER);
    p.on("response", (r) => {
      const m = r
        .url()
        .match(/\/rpc\/(submit_definition|cast_vote|rejoin_room)\b/);
      if (m && r.ok()) acts.push({ who, what: m[1]!, at: Date.now() });
    });
  }
  const evs = (p: Page) =>
    p.evaluate(() => (window as unknown as { __sync: Ev[] }).__sync);
  const autoMs: number[] = [];
  // F — aviso PERDIDO (SYNC_DROP_NUDGE=1): o host não recebe nenhum
  // "round-sync-needed"; o que ele vê tem de chegar pelo realtime/poll
  let dropped = 0;
  let frames = 0;
  if (process.env.SYNC_DROP_NUDGE === "1")
    await host.routeWebSocket(/realtime/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        frames++;
        // o realtime-js 2.x manda broadcast em quadro BINÁRIO
        const txt =
          typeof m === "string" ? m : Buffer.from(m).toString("latin1");
        if (txt.includes("round-sync-needed")) {
          dropped++;
          return;
        }
        ws.send(m);
      });
    });
  let code = "";
  try {
    await host.goto("/");
    await expect(async () => {
      await host.getByRole("button", { name: /Criar sala/ }).click();
      await expect(host.getByPlaceholder(NICK)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await host.getByPlaceholder(NICK).fill("Host S");
    await expect(async () => {
      if (!/\/room\/\d{4}/.test(host.url()))
        await host
          .getByRole("button", { name: /Criar!/ })
          .click({ timeout: 3_000 });
      await expect(host).toHaveURL(/\/room\/\d{4}/, { timeout: 8_000 });
    }).toPass({ timeout: 45_000 });
    code = host.url().match(/room\/(\d{4})/)![1]!;
    console.log(`SALA ${code}`);
    await host.waitForTimeout(1_500);
    await guest.goto(`/room/${code}`);
    await expect(guest.getByPlaceholder(NICK)).toBeVisible({ timeout: 30_000 });
    await guest.getByPlaceholder(NICK).fill("Conv S");
    await guest.getByRole("button", { name: /Entrar na sala/ }).click();
    await expect(host.getByText("Conv S").first()).toBeVisible({
      timeout: 30_000,
    });
    const seated = async () =>
      Number(
        ((await host.locator("body").innerText()).match(
          /Jogadores \((\d+)\/12\)/i,
        ) ?? [])[1] ?? 0,
      );
    for (let i = 0; i < 2; i++) {
      const before = await seated();
      await host.getByRole("button", { name: /\+1 Bot/ }).click();
      await expect.poll(seated, { timeout: 30_000 }).toBeGreaterThan(before);
    }
    await host.getByRole("button", { name: /Começar/ }).click();
    const humans = () =>
      [
        ["host", host],
        ["convidado", guest],
      ] as const;
    for (let round = 1; round <= ROUNDS; round++) {
      if (round === SLOW) {
        const cdp = await hostCtx.newCDPSession(host);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 400,
          downloadThroughput: 750_000 / 8,
          uploadThroughput: 250_000 / 8,
        });
        console.log(`RODADA ${round}: host com rede lenta (400 ms)`);
      }
      await expect(async () => {
        let acted = false;
        for (const [, p] of humans()) {
          const sortear = p.getByRole("button", { name: /Sortear palavra/ });
          if (await sortear.isVisible().catch(() => false)) {
            await sortear.click({ force: true, timeout: 3_000 });
            await p
              .locator("button.sticker")
              .first()
              .click({ force: true, timeout: 15_000 });
            acted = true;
          }
        }
        void acted;
        const inWriting = await Promise.all(
          humans().map(
            async ([, p]) =>
              (await p
                .getByPlaceholder(WRITE)
                .isVisible()
                .catch(() => false)) ||
              (await p
                .getByText(/Você é o coordenador/i)
                .first()
                .isVisible()
                .catch(() => false)),
          ),
        );
        expect(inWriting.some(Boolean)).toBeTruthy();
      }).toPass({ timeout: 120_000, intervals: [1_000] });
      // escrita: o convidado envia primeiro; o host, 3 s depois (é quem fecha)
      const order = [
        ["convidado", guest],
        ["host", host],
      ] as const;
      for (const [name, p] of order) {
        const field = p.getByPlaceholder(WRITE);
        const coord = p.getByText(/Você é o coordenador/i).first();
        // coordenador (não escreve) cuja escrita já acabou — convidado + bots
        // fecharam antes de chegar a vez dele: segue para a votação
        const past = p
          .getByText(/embaralhando as cédulas|Qual é o significado de/i)
          .first();
        await expect
          .poll(
            async () =>
              (await field.isVisible().catch(() => false)) ||
              (await coord.isVisible().catch(() => false)) ||
              (await past.isVisible().catch(() => false)),
            { timeout: 90_000, intervals: [250] },
          )
          .toBe(true);
        if (!(await field.isVisible().catch(() => false))) continue;
        // 🤖 definição automática: toque → campo preenchido
        await p.waitForTimeout(4_500); // o jogador lê a palavra (e a cortina sai)
        const t0 = Date.now();
        await p
          .getByRole("button", { name: /gerar definição automática/ })
          .click();
        await expect
          .poll(
            async () => (await field.inputValue().catch(() => "")).length > 0,
            {
              timeout: 10_000,
              intervals: [20],
            },
          )
          .toBe(true);
        autoMs.push(Date.now() - t0);
        await expect(async () => {
          await field.fill(`${BLUFF[name]} ${round}`);
          await p
            .getByRole("button", { name: /Enviar definição/ })
            .click({ timeout: 3_000 });
          await expect(field).toBeHidden({ timeout: 3_000 });
        }).toPass({ timeout: 30_000 });
        if (name === "convidado") await p.waitForTimeout(3_000);
      }
      // votação: convidado vota; o host, 2 s depois
      const ballots = (p: Page) =>
        p.locator("button:has(.token):not([disabled])");
      await expect(ballots(guest).first()).toBeVisible({ timeout: 120_000 });
      await expect(ballots(host).first()).toBeVisible({ timeout: 30_000 });
      await guest.waitForTimeout(500);
      await ballots(guest).first().click({ force: true });
      await host.waitForTimeout(2_000);
      await ballots(host).first().click({ force: true });
      await expect(
        host.getByText(/Como cada um pontuou|Pontuação por equipe/i).first(),
      ).toBeVisible({
        timeout: 120_000,
      });
      await expect(
        guest.getByText(/Como cada um pontuou|Pontuação por equipe/i).first(),
      ).toBeVisible({
        timeout: 30_000,
      });
      console.log(`RODADA ${round} OK`);
      if (round === ROUNDS) break;
      await host
        .getByRole("button", { name: /Próxima rodada/ })
        .click({ timeout: 20_000 });
    }
  } finally {
    const H = await evs(host).catch(() => [] as Ev[]);
    const G = await evs(guest).catch(() => [] as Ev[]);
    const xOf = (v: string) => Number((v.match(/(\d+)\//) ?? [])[1] ?? -1);
    const q = (arr: number[], f: number) => {
      const a = [...arr].sort((x, y) => x - y);
      return a.length
        ? a[Math.min(a.length - 1, Math.floor(f * a.length))]
        : null;
    };
    const rows: string[] = [];
    const deltas: Record<string, number[]> = {
      enviaram: [],
      votaram: [],
      jogadores: [],
      fase: [],
    };
    // ação confirmada num aparelho → quando o OUTRO mostra o mesmo valor
    for (const a of acts) {
      const key =
        a.what === "submit_definition"
          ? "enviaram"
          : a.what === "cast_vote"
            ? "votaram"
            : "jogadores";
      const mine = a.who === "host" ? H : G;
      const other = a.who === "host" ? G : H;
      const own = mine
        .filter(([t, k, v]) => k === key && v && t <= a.at + 300)
        .pop();
      const target = own ? xOf(own[2]) : -1;
      const seen =
        target >= 0
          ? other.find(
              ([t, k, v]) => k === key && t >= a.at - 300 && xOf(v) >= target,
            )
          : undefined;
      if (seen) deltas[key]!.push(Math.max(0, seen[0] - a.at));
      rows.push(
        `${a.what} (${a.who}) [${own?.[2] ?? "?"}] → outro vê em ${seen ? Math.max(0, seen[0] - a.at) + " ms" : "— (a fase virou antes)"}`,
      );
    }
    // mudança de fase: host × convidado
    const phases = (log: Ev[]) => log.filter(([, k, v]) => k === "fase" && v);
    const hp = phases(H);
    const gp = phases(G);
    for (const [t, , v] of hp) {
      const g = gp.find(([tg, , vg]) => vg === v && Math.abs(tg - t) < 8_000);
      if (g) deltas.fase!.push(Math.abs(g[0] - t));
      rows.push(`fase ${v}: convidado Δ ${g ? g[0] - t : "—"} ms`);
    }
    for (const [k, arr] of Object.entries(deltas))
      rows.push(
        `RESUMO ${k}: n=${arr.length} média=${arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : "—"} P50=${q(arr, 0.5)} P95=${q(arr, 0.95)} máx=${arr.length ? Math.max(...arr) : "—"}`,
      );
    console.log("=== SINCRONIZAÇÃO\n" + rows.join("\n"));
    if (process.env.SYNC_DROP_NUDGE === "1")
      console.log(
        `=== AVISOS DESCARTADOS NO HOST: ${dropped} (quadros do servidor vistos: ${frames})`,
      );
    const sorted = [...autoMs].sort((a, b) => a - b);
    const pct = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    console.log(
      `=== AUTO ${JSON.stringify(autoMs)} P50=${pct(0.5)} P95=${pct(0.95)}`,
    );
    console.log(`=== JSON ${JSON.stringify({ code, acts, H, G, autoMs })}`);
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
    await guestCtx.close();
  }
});
