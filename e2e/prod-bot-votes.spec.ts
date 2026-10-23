import { test, expect, type Page } from "@playwright/test";

// Partida real num deploy (E2E_BASE_URL) com a política nova de voto dos
// bots (2026-10-22) — só com BOT_VOTES=1. Dois humanos + N bots, R rodadas.
// Mede, pelas respostas do próprio servidor na revelação (get_round_sync já
// com autor), quantos votos de bot caíram na verdade; e prova que a rodada
// não trava com o host fora da tela: na votação da 1ª rodada o host vota e
// é CONGELADO (JS parado, como o iPhone bloqueado); o convidado vota por
// último e pede o voto dos bots. No fim o host reseta a sala para o lobby.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.BOT_VOTES,
  "só contra um deploy (E2E_BASE_URL) com BOT_VOTES=1",
);
test.setTimeout(1_200_000);

const NICK = "Ex: Bia, Zé, Dudu...";
const WRITE = "escreva sua definicao mirabolante...";
const BOTS = Number(process.env.BOT_VOTES_BOTS ?? 3);
const ROUNDS = Number(process.env.BOT_VOTES_ROUNDS ?? 6);
const BLUFF = {
  host: "utensilio antigo de cozinha usado para ralar milho",
  convidado: "danca de roda tipica das festas do interior",
};

type SyncDef = { id: string; player_id: string; round: number };
type SyncVote = { voter_id: string; definition_id: string; round: number };

test(`política nova dos bots: 2 humanos + ${BOTS} bots, ${ROUNDS} rodadas`, async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  // respostas do servidor na revelação: cédulas com autor + votos
  const reveal = new Map<number, { truth: string; votes: SyncVote[] }>();
  const botCalls: Array<{
    who: string;
    at: number;
    actor: string;
    res: string;
  }> = [];
  const watch = (p: Page, who: string) => {
    p.on("response", async (r) => {
      const url = r.url();
      if (
        url.includes("/rpc/get_round_sync") ||
        url.includes("/rpc/get_room_state")
      ) {
        const j = (await r.json().catch(() => null)) as {
          definitions?: SyncDef[];
          votes?: SyncVote[];
        } | null;
        const defs = j?.definitions ?? [];
        const truth = defs.find((d) => d.player_id === "__truth__");
        if (truth && j?.votes)
          reveal.set(truth.round, { truth: truth.id, votes: j.votes });
      }
      if (url.includes("/rpc/cast_bot_votes")) {
        const body = JSON.parse(r.request().postData() ?? "{}") as {
          p_actor_id?: string;
        };
        botCalls.push({
          who,
          at: Date.now(),
          actor: body.p_actor_id ?? "",
          res: (await r.text().catch(() => "")).slice(0, 80),
        });
      }
    });
  };
  watch(host, "host");
  watch(guest, "convidado");
  let code = "";
  let awayRevealMs: number | null = null;
  let awayMode = "";
  try {
    await host.goto("/");
    await expect(async () => {
      await host.getByRole("button", { name: /Criar sala/ }).click();
      await expect(host.getByPlaceholder(NICK)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await host.getByPlaceholder(NICK).fill("Host BV");
    await expect(async () => {
      if (!/\/room\/\d{4}/.test(host.url()))
        await host
          .getByRole("button", { name: /Criar!/ })
          .click({ timeout: 3_000 });
      await expect(host).toHaveURL(/\/room\/\d{4}/, { timeout: 8_000 });
    }).toPass({ timeout: 45_000 });
    code = host.url().match(/room\/(\d{4})/)![1]!;
    console.log(`SALA ${code}`);

    await guest.goto(`/room/${code}`);
    await expect(guest.getByPlaceholder(NICK)).toBeVisible({ timeout: 30_000 });
    await guest.getByPlaceholder(NICK).fill("Conv BV");
    await guest.getByRole("button", { name: /Entrar na sala/ }).click();
    await expect(host.getByText("Conv BV").first()).toBeVisible({
      timeout: 30_000,
    });

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
    await host.getByRole("button", { name: /Começar/ }).click();

    const humans = () =>
      [
        ["host", host],
        ["convidado", guest],
      ] as const;
    const ballots = (p: Page) =>
      p.locator("button:has(.token):not([disabled])");
    for (let round = 1; round <= ROUNDS; round++) {
      // escolha: coordenador humano sorteia; bot escolhe sozinho
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
        const writing = await Promise.all(
          humans().map(([, p]) =>
            p
              .getByPlaceholder(WRITE)
              .isVisible()
              .catch(() => false),
          ),
        );
        expect(acted || writing.some(Boolean)).toBeTruthy();
      }).toPass({ timeout: 90_000, intervals: [1_000] });
      // escrita: cada humano espera o seu papel (campo de escrita ou
      // coordenador) — conferir cedo pulava quem ainda estava na transição
      for (const [name, p] of humans()) {
        const field = p.getByPlaceholder(WRITE);
        const coord = p.getByText(/Você é o coordenador/i).first();
        await expect
          .poll(
            async () =>
              (await field.isVisible().catch(() => false)) ||
              (await coord.isVisible().catch(() => false)),
            { timeout: 90_000, intervals: [500] },
          )
          .toBe(true);
        if (!(await field.isVisible().catch(() => false))) continue;
        await expect(async () => {
          await field.fill(`${BLUFF[name]} ${round}`);
          await p
            .getByRole("button", { name: /Enviar definição/ })
            .click({ timeout: 3_000 });
          await expect(field).toBeHidden({ timeout: 3_000 });
        }).toPass({ timeout: 30_000 });
      }
      // votação
      await expect(ballots(host).first()).toBeVisible({ timeout: 90_000 });
      await expect(ballots(guest).first()).toBeVisible({ timeout: 30_000 });
      await host.waitForTimeout(800);
      await ballots(host).first().click({ force: true });
      if (round === 1) {
        // host fora da tela: sem rede depois de votar (o congelamento por
        // CDP sozinho não para o JS de uma página visível — 1ª medição)
        await host.waitForTimeout(1_500);
        await hostCtx.setOffline(true);
        awayMode = "sem rede";
        const t = Date.now();
        await ballots(guest).first().click({ force: true });
        await expect(
          guest.getByText(/A definição verdadeira/i).first(),
        ).toBeVisible({
          timeout: 45_000,
        });
        awayRevealMs = Date.now() - t;
        console.log(
          `HOST FORA (${awayMode}): revelação no convidado ${awayRevealMs} ms depois do último voto humano`,
        );
        await hostCtx.setOffline(false);
      } else {
        await guest.waitForTimeout(600);
        await ballots(guest).first().click({ force: true });
      }
      // revelação → placar → próxima rodada
      await expect(
        host.getByText(/Como cada um pontuou|Pontuação por equipe/i).first(),
      ).toBeVisible({
        timeout: 120_000,
      });
      console.log(`RODADA ${round} OK`);
      if (round === ROUNDS) break;
      await host
        .getByRole("button", { name: /Próxima rodada/ })
        .click({ timeout: 20_000 });
    }
  } finally {
    let botVotes = 0;
    let onTruth = 0;
    let humanVotes = 0;
    let humanTruth = 0;
    for (const [round, r] of [...reveal.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const vs = r.votes.filter((v) => v.round === round);
      const bots = vs.filter((v) => v.voter_id.startsWith("bot_"));
      const hums = vs.filter((v) => !v.voter_id.startsWith("bot_"));
      botVotes += bots.length;
      onTruth += bots.filter((v) => v.definition_id === r.truth).length;
      humanVotes += hums.length;
      humanTruth += hums.filter((v) => v.definition_id === r.truth).length;
      console.log(
        `rodada ${round}: bots na verdade ${bots.filter((v) => v.definition_id === r.truth).length}/${bots.length}; humanos ${hums.filter((v) => v.definition_id === r.truth).length}/${hums.length}`,
      );
    }
    console.log(`=== BOTS NA VERDADE: ${onTruth}/${botVotes}`);
    console.log(`=== HUMANOS NA VERDADE: ${humanTruth}/${humanVotes}`);
    console.log(
      `=== PEDIDOS cast_bot_votes: ${botCalls.map((c) => `${c.who}:${c.res}`).join(" | ")}`,
    );
    console.log(
      `=== JSON ${JSON.stringify({ code, onTruth, botVotes, humanTruth, humanVotes, awayRevealMs, awayMode })}`,
    );
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
  expect(awayRevealMs, "com o host fora a rodada revelou").not.toBeNull();
  expect(
    botCalls.some(
      (c) => c.who === "convidado" && /"inserted": ?[1-9]/.test(c.res),
    ),
    "com o host fora, o convidado pediu e os bots votaram",
  ).toBe(true);
});
