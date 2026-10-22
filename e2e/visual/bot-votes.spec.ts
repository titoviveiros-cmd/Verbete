// Voto dos bots (playtest 2026-10-22): o servidor escolhe, e os bots votam
// POR ÚLTIMO — com a política nova, ver em que cédula um bot votou enquanto
// humanos ainda votam seria uma pista da verdade. Host com um bot pendente:
// nenhum pedido de voto de bot antes do último humano; depois dele, um
// pedido só, sem cédula escolhida pelo navegador.
import { expect, test } from "@playwright/test";
import { installSupabaseMock, type MockBackend } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage } from "./fixtures";

type Vote = { voter_id: string; definition_id: string; round: number };
type Def = { id: string; player_id: string; letter: string | null };

test("host: bots votam só depois do último humano, e quem escolhe é o servidor", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const backend = roomBackend("voting") as MockBackend;
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
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("voting"));
  await page.goto(`/room/${ROOM_CODE}`);
  const choices = page.locator("button:has(.token):not([disabled])");
  await expect(choices.first()).toBeVisible({ timeout: 25_000 });
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
    `voto dos bots pedido ${botCalls[0]!.at - tapAt} ms depois do último humano: ${botCalls[0]!.fn} ${botCalls[0]!.body}`,
  );
  expect(botCalls, "um pedido só").toHaveLength(1);
  expect(botCalls[0]!.fn).toBe("cast_bot_votes");
  const body = JSON.parse(botCalls[0]!.body) as Record<string, unknown>;
  expect(Object.keys(body).sort(), "sem cédula escolhida no navegador").toEqual(
    ["p_room_id", "p_round"],
  );
});
