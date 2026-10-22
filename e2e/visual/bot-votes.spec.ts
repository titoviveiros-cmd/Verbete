// Voto dos bots (playtest 2026-10-22): o servidor escolhe, e os bots votam
// POR ÚLTIMO — com a política nova, ver em que cédula um bot votou enquanto
// humanos ainda votam seria uma pista da verdade. Com um bot pendente:
// nenhum pedido de voto de bot antes do último humano; depois dele, um
// pedido sem cédula escolhida pelo navegador — feito pelo host ou, se o
// host saiu da tela, por quem votou por último (Red Team 2026-10-22).
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock, type MockBackend } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage } from "./fixtures";

type Vote = {
  id?: string;
  voter_id: string;
  definition_id: string;
  round: number;
};
type Def = { id: string; player_id: string; letter: string | null };

async function setup(page: Page, guest: boolean) {
  const backend = roomBackend("voting", { guest }) as MockBackend;
  backend.rpc["cast_bot_votes"] = { ok: true, inserted: 1 };
  // o bot (TioBlefe) ainda não votou; Zé e Nina já: falta só a Bia (eu)
  const sync = backend.rpc["get_round_sync"] as unknown as {
    votes: Vote[];
    definitions: Def[];
  };
  const state = backend.rpc["get_room_state"] as unknown as { votes: Vote[] };
  const ballot = sync.definitions.filter((d) => d.letter);
  for (const list of [sync.votes, state.votes]) {
    const tio = list.findIndex(
      (v) => v.voter_id === "bot_tio" && v.round === 3,
    );
    if (tio >= 0) list.splice(tio, 1);
    for (const voter of ["p_ze004", "p_nina5"])
      if (!list.some((v) => v.voter_id === voter && v.round === 3))
        list.push({
          ...list[0]!,
          voter_id: voter,
          definition_id: ballot.find((d) => d.player_id !== voter)!.id,
          round: 3,
        });
  }
  const botCalls: Array<{ fn: string; at: number; body: string }> = [];
  page.on("request", (r) => {
    const m = r.url().match(/\/rpc\/(cast_bot_votes|cast_votes_bulk)/);
    if (m)
      botCalls.push({ fn: m[1]!, at: Date.now(), body: r.postData() ?? "" });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await installSupabaseMock(page, backend);
  // o voto da Bia chega ao "banco": o próximo poll o devolve como voto REAL
  // (o cliente espera o voto real, não o otimista, antes de pedir os bots)
  await page.route("**/rest/v1/rpc/cast_vote", async (route) => {
    const req = JSON.parse(route.request().postData() ?? "{}") as {
      p_voter_id: string;
      p_definition_id: string;
    };
    for (const list of [sync.votes, state.votes])
      list.push({
        ...list[0]!,
        id: "v-bia-real",
        voter_id: req.p_voter_id,
        definition_id: req.p_definition_id,
        round: 3,
      } as Vote);
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("voting"));
  await page.goto(`/room/${ROOM_CODE}`);
  const choices = page.locator("button:has(.token):not([disabled])");
  await expect(choices.first()).toBeVisible({ timeout: 25_000 });
  return { botCalls, choices };
}

test("host: bots votam só depois do último humano, e quem escolhe é o servidor", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { botCalls, choices } = await setup(page, false);
  // antes, o bot votava sozinho em 0,9–2,3 s, com humano ainda votando
  await page.waitForTimeout(3_500);
  expect(botCalls, "nenhum voto de bot antes do último humano").toHaveLength(0);
  const tapAt = Date.now();
  await choices.first().click();
  await expect
    .poll(() => botCalls.length, { timeout: 5_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1_500);
  console.log(
    `host: voto dos bots pedido ${botCalls[0]!.at - tapAt} ms depois do último humano: ${botCalls[0]!.fn} ${botCalls[0]!.body}`,
  );
  expect(botCalls, "um pedido só").toHaveLength(1);
  expect(botCalls[0]!.fn).toBe("cast_bot_votes");
  const body = JSON.parse(botCalls[0]!.body) as Record<string, unknown>;
  expect(Object.keys(body).sort(), "sem cédula escolhida no navegador").toEqual(
    ["p_actor_id", "p_room_id", "p_round"],
  );
});

test("host fora da tela: quem votou por último (convidado) pede o voto dos bots", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { botCalls, choices } = await setup(page, true);
  await page.waitForTimeout(3_000);
  expect(botCalls, "nenhum voto de bot antes do último humano").toHaveLength(0);
  const tapAt = Date.now();
  await choices.first().click();
  await expect
    .poll(() => botCalls.length, { timeout: 8_000 })
    .toBeGreaterThan(0);
  console.log(
    `convidado: voto dos bots pedido ${botCalls[0]!.at - tapAt} ms depois do último humano: ${botCalls[0]!.fn} ${botCalls[0]!.body}`,
  );
  expect(botCalls[0]!.fn).toBe("cast_bot_votes");
  expect(
    (JSON.parse(botCalls[0]!.body) as { p_actor_id?: string }).p_actor_id,
  ).toBe("p_bia01");
});
