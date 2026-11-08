// Resultado compartilhado (09/11/2026), no navegador com o Supabase simulado:
// botão da tela final (4 desfechos distintos + link do RESULTADO, não da Home),
// página pública /r/<token> (sem login), equipes, link inválido/expirado e o
// redirecionamento /?r=<token> da Home.
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage, homeBackend } from "./fixtures";

const TOKEN = "0123456789abcdef0123456789abcdef";
const LINK = `https://jogo.verbete.workers.dev/?r=${TOKEN}`;
const PROIBIDO = /@|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|4827/i; // e-mail, UUID ou código da sala

const SNAP_SOLO = {
  v: 1,
  mode: "solo",
  rounds: 3,
  finished_at: "2026-11-08T19:00:00Z",
  expires_at: "2026-12-08T19:00:00Z",
  players: [
    {
      rank: 1,
      nickname: "Zé",
      avatar: "🐸",
      color: "#06D6A0",
      score: 15,
      bot: false,
      team: null,
    },
    {
      rank: 2,
      nickname: "Bia",
      avatar: "🦊",
      color: "#FF5C8A",
      score: 12,
      bot: false,
      team: null,
    },
    {
      rank: 2,
      nickname: "Lu",
      avatar: "🦉",
      color: "#A155F0",
      score: 12,
      bot: true,
      team: null,
    },
    {
      rank: 4,
      nickname: "Dudu",
      avatar: "🐻",
      color: "#FFD166",
      score: 4,
      bot: false,
      team: null,
    },
  ],
  teams: [],
};
const SNAP_TEAMS = {
  ...SNAP_SOLO,
  mode: "teams",
  players: SNAP_SOLO.players.map((p, i) => ({
    ...p,
    team: i % 2 ? "Raposas" : "Corujas",
  })),
  teams: [
    {
      rank: 1,
      name: "Corujas",
      emoji: "🦉",
      color: "#5B6CFF",
      score: 27,
      members: 2,
    },
    {
      rank: 2,
      name: "Raposas",
      emoji: "🦊",
      color: "#FF8A3D",
      score: 16,
      members: 2,
    },
  ],
};

async function finishedRoom(page: Page, share: "ok" | "erro" = "ok") {
  const b = roomBackend("finished", { loggedIn: true });
  b.rpc.create_match_share =
    share === "ok"
      ? {
          ok: true,
          token: TOKEN,
          expires_at: "2026-12-08T19:00:00Z",
          champions: [{ name: "Bia", emoji: "🦊", score: 13 }],
        }
      : { ok: false, reason: "not_participant" };
  b.rpc.claim_player_identity = null;
  b.rpc.record_match_result = { ok: true, deduped: true, xp_gained: 0 };
  const log = await installSupabaseMock(page, b);
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage("finished"));
  return log;
}
/** Substitui o Web Share / a área de transferência do navegador para cada desfecho. */
async function stubShare(
  page: Page,
  mode: "shared" | "cancel" | "clipboard" | "fail",
) {
  await page.addInitScript((m) => {
    const w = window as unknown as {
      __shared?: unknown[];
      __copied?: string[];
    };
    w.__shared = [];
    w.__copied = [];
    const nav = navigator as unknown as Record<string, unknown>;
    if (m === "shared")
      nav.share = async (d: unknown) => {
        w.__shared!.push(d);
      };
    else if (m === "cancel")
      nav.share = async () => {
        throw new DOMException("cancelado", "AbortError");
      };
    else
      Object.defineProperty(navigator, "share", {
        value: undefined,
        configurable: true,
      });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (t: string) => {
          if (m === "fail") throw new Error("negado");
          w.__copied!.push(t);
        },
      },
    });
  }, mode);
}
const shareButton = (page: Page) =>
  page.getByRole("button", { name: /Compartilhar resultado/ });

test("fim de partida: compartilha o LINK DO RESULTADO (não a Home) e confirma", async ({
  page,
}) => {
  const log = await finishedRoom(page);
  await stubShare(page, "shared");
  await page.goto(`/room/${ROOM_CODE}`);
  await expect(
    page.getByText("Fim de jogo", { exact: false }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await shareButton(page).click();
  await expect(page.getByText("Resultado compartilhado! ✅")).toBeVisible();
  const shared = await page.evaluate(
    () =>
      (window as unknown as { __shared: Array<{ url: string; text: string }> })
        .__shared,
  );
  expect(shared).toHaveLength(1);
  expect(shared[0]!.url).toBe(LINK);
  expect(shared[0]!.url).not.toBe("https://jogo.verbete.workers.dev/");
  // texto com o campeão DECIDIDO PELO SERVIDOR (resposta do create_match_share)
  expect(shared[0]!.text).toBe(
    "🏆 Bia venceu no Verbete com 13 pts! Veja o resultado da partida:",
  );
  // 2º clique: mesmo link, SEM nova consulta (o link foi preparado ao abrir a
  // tela; em desenvolvimento o modo estrito do React monta o efeito 2×)
  const consultas = () =>
    log.calls.filter((c) => c.endsWith("/rpc/create_match_share")).length;
  const antes = consultas();
  expect(antes).toBeGreaterThanOrEqual(1);
  await shareButton(page).click();
  await expect(page.getByText("Resultado compartilhado! ✅")).toBeVisible();
  expect(consultas()).toBe(antes);
  const shared2 = await page.evaluate(
    () => (window as unknown as { __shared: Array<{ url: string }> }).__shared,
  );
  expect(shared2.map((x) => x.url)).toEqual([LINK, LINK]);
  await page.screenshot({
    path: "test-results/compartilhar-resultado-fim.png",
  });
});

test("fim de partida: sem Web Share → copia o link do resultado", async ({
  page,
}) => {
  await finishedRoom(page);
  await stubShare(page, "clipboard");
  await page.goto(`/room/${ROOM_CODE}`);
  await shareButton(page).click({ timeout: 30_000 });
  await expect(page.getByText("Link do resultado copiado! ✅")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __copied: string[] }).__copied,
    ),
  ).toEqual([LINK]);
});

test("fim de partida: cancelar e falhar têm mensagens distintas; falha mostra o link para copiar", async ({
  page,
}) => {
  await finishedRoom(page);
  await stubShare(page, "cancel");
  await page.goto(`/room/${ROOM_CODE}`);
  await shareButton(page).click({ timeout: 30_000 });
  await expect(page.getByText("Compartilhamento cancelado.")).toBeVisible();

  const p2 = await page.context().newPage();
  await finishedRoom(p2);
  await stubShare(p2, "fail");
  await p2.goto(`/room/${ROOM_CODE}`);
  await shareButton(p2).click({ timeout: 30_000 });
  await expect(
    p2.getByText(/Não deu para abrir o compartilhamento/),
  ).toBeVisible();
  await expect(p2.getByLabel("Link do resultado")).toHaveValue(LINK);
});

test("fim de partida: servidor recusa o link → aviso, sem compartilhar a Home", async ({
  page,
}) => {
  await finishedRoom(page, "erro");
  await stubShare(page, "shared");
  await page.goto(`/room/${ROOM_CODE}`);
  await shareButton(page).click({ timeout: 30_000 });
  // motivo específico (Red Team E), nunca o link da Home
  await expect(
    page.getByText(
      "Só quem jogou esta partida até o fim pode compartilhar o resultado.",
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __shared: unknown[] }).__shared,
    ),
  ).toEqual([]);
});

test("/r/<token>: resultado público sem login — pódio, campeão e pontuação; nada pessoal", async ({
  page,
}) => {
  const b = homeBackend(false);
  b.rpc.get_match_share = SNAP_SOLO;
  b.user = null;
  await installSupabaseMock(page, b);
  await page.goto(`/r/${TOKEN}`);
  await expect(page.getByRole("heading", { name: /Zé venceu!/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Pontuação final")).toBeVisible();
  await expect(page.getByText("🤖 robô")).toBeVisible();
  await expect(page.getByText(/disponível até/)).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(PROIBIDO);
  await page.screenshot({
    path: "test-results/compartilhar-resultado-publico.png",
    fullPage: true,
  });
});

test("/r/<token>: partida em equipes mostra a equipe campeã e o ranking por equipe", async ({
  page,
}) => {
  const b = homeBackend(false);
  b.rpc.get_match_share = SNAP_TEAMS;
  b.user = null;
  await installSupabaseMock(page, b);
  await page.goto(`/r/${TOKEN}`);
  await expect(
    page.getByRole("heading", { name: /Corujas venceu!/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Ranking por equipe")).toBeVisible();
  await expect(page.getByText("27 pts", { exact: true })).toBeVisible();
});

test("/r/<token> inexistente ou expirado: 'Resultado indisponível' e convite para jogar", async ({
  page,
}) => {
  const b = homeBackend(false);
  b.rpc.get_match_share = null;
  b.user = null;
  await installSupabaseMock(page, b);
  await page.goto(`/r/${TOKEN}`);
  await expect(
    page.getByRole("heading", { name: "Resultado indisponível" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: /Jogar Verbete/ })).toBeVisible();
});

test("/r/<lixo>: formato inválido nem consulta o servidor", async ({
  page,
}) => {
  const b = homeBackend(false);
  b.user = null;
  const log = await installSupabaseMock(page, b);
  await page.goto("/r/1234");
  await expect(
    page.getByRole("heading", { name: "Resultado indisponível" }),
  ).toBeVisible({ timeout: 30_000 });
  expect(log.calls.filter((c) => c.includes("get_match_share"))).toEqual([]);
});

test("Home /?r=<token> leva ao resultado (o link compartilhado)", async ({
  page,
}) => {
  const b = homeBackend(false);
  b.rpc.get_match_share = SNAP_SOLO;
  b.user = null;
  await installSupabaseMock(page, b);
  await page.goto(`/?r=${TOKEN}`);
  await expect(page).toHaveURL(new RegExp(`/r/${TOKEN}$`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /Zé venceu!/ })).toBeVisible();
});

test("/r/<token>: empate mostra 'Empate!' com todos os campeões do servidor", async ({
  page,
}) => {
  const b = homeBackend(false);
  b.rpc.get_match_share = {
    ...SNAP_SOLO,
    players: [
      { ...SNAP_SOLO.players[0]!, rank: 1, score: 12 },
      ...SNAP_SOLO.players.slice(1),
    ],
    champions: [
      { name: "Bia", emoji: "🦊", score: 12 },
      { name: "Lu", emoji: "🦉", score: 12 },
      { name: "Zé", emoji: "🐸", score: 12 },
    ],
  };
  b.user = null;
  await installSupabaseMock(page, b);
  await page.goto(`/r/${TOKEN}`);
  await expect(
    page.getByRole("heading", { name: /Empate! Bia, Lu e Zé/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("12 pts cada")).toBeVisible();
});
