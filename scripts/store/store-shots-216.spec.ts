// Capturas REAIS do app (tema claro, o padrão do app) para a ficha Google Play
// da 2.1.6 (20/11/2026). Mesmo método das coleções de 28/10 e 11/11: sala
// congelada em cada fase, jogadores fictícios, Supabase e server functions
// SIMULADOS (nada sai da máquina). Fora das suítes do CI:
//   npx playwright test -c scripts/store/playwright.store-216.config.ts
// Saída bruta em resources/store/play-2.1.6/_raw/ (moldura: gen-store-216.mjs).
// Novidades em relação a 11/11: Diário no modo ESCOLHA (o de produção),
// rodapé v2.1.6, Perfil com conquistas consultáveis (PR #77), escrita com a
// definição sendo digitada.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { toCrossJSON } from "seroval";
import { installSupabaseMock } from "../../e2e/visual/supabase-mock";
import {
  ROOM_CODE,
  USER_ID,
  dailyBackend,
  homeBackend,
  roomStorage,
  type Phase,
} from "../../e2e/visual/fixtures";
import {
  blockedButtons,
  clippedByAncestors,
  truncatedTexts,
} from "../../e2e/visual/occlusion";
import { roomBackendSemIa } from "./store-fixtures-sem-ia";
import { FONT_FILES, fontBytes, fontFaceCss } from "./local-fonts.mjs";

const RAW = resolve(process.cwd(), "resources/store/play-2.1.6/_raw");
mkdirSync(RAW, { recursive: true });

// Requisições a hosts externos tentadas pela página (bloqueadas): tem de terminar vazia.
const externos: string[] = [];
const FONTES_LOCAIS = "https://fonts.gstatic.com/local/";

async function prepare(page: Page, storage: Record<string, string>) {
  // Trava de rede (21/11/2026): só localhost/127.0.0.1 (app + Supabase simulado) sai do
  // navegador. As fontes do Google viram arquivos LOCAIS (scripts/store/fonts, OFL);
  // qualquer outro host — inclusive um Supabase de verdade — é abortado e registrado.
  // Registrada depois do mock: para hosts locais devolve a vez (fallback) aos handlers dele.
  externos.length = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return route.fallback();
    if (url.hostname === "fonts.googleapis.com")
      return route.fulfill({ status: 200, contentType: "text/css", body: fontFaceCss(FONTES_LOCAIS) });
    if (url.href.startsWith(FONTES_LOCAIS) && FONT_FILES.includes(url.pathname.split("/").pop()!))
      return route.fulfill({ status: 200, contentType: "font/woff2", body: fontBytes(url.pathname.split("/").pop()!) });
    externos.push(url.origin);
    return route.abort();
  });
  await page.addInitScript(
    (entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    },
    { ...storage, "verbete:theme": "light" },
  );
}

// Animações de entrada (framer-motion, opacity) terminadas — critério do screens.spec.
async function entradaConcluida(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLElement>('[style*="opacity"]')]
              .filter((el) => !el.closest("[aria-hidden]"))
              .filter((el) => Number(getComputedStyle(el).opacity) < 0.99)
              .length,
        ),
      { message: "animação de entrada não terminou", timeout: 10_000 },
    )
    .toBe(0);
}

async function room(page: Page, phase: Phase, opts: { loggedIn?: boolean } = {}) {
  const backend = roomBackendSemIa(phase, { loggedIn: opts.loggedIn ?? false });
  const log = await installSupabaseMock(page, backend);
  await prepare(page, roomStorage(phase));
  await page.goto(`/room/${ROOM_CODE}`);
  return log;
}

// Diário em produção = modo ESCOLHA (4 alternativas, sem IA): o mesmo contrato
// do e2e/visual/daily-choice.spec.ts (resposta da server function simulada).
const OPCOES = [
  { pos: 0, text: "Castigo aplicado em público, na praça" },
  { pos: 1, text: "Prêmio dado a quem traz boas notícias" },
  { pos: 2, text: "Moeda antiga de pouco valor, de cobre" },
  { pos: 3, text: "Pequena caixa de madeira para joias" },
];

// Catálogo REAL de conquistas (o mesmo do e2e/visual/achievements.spec.ts = migrations em produção).
const CATALOGO: Array<[string, string, string, string, string]> = [
  ["acertos_100", "Mestre das Palavras", "Acerte a definição verdadeira 100 vezes.", "🧠", "epic"],
  ["big_score", "Pontuação Massiva", "Faça 30+ pontos em uma única partida.", "💯", "epic"],
  ["bluff_master", "Mestre do Blefe", "Receba 5+ votos em uma única definição falsa.", "🎭", "rare"],
  ["bluffs_100", "Professor do Blefe", "Engane jogadores 100 vezes com suas definições.", "🎓", "epic"],
  ["coordinator_5", "Coordenador Nato", "Coordene 5 rodadas.", "🎯", "rare"],
  ["first_daily", "Estreante Diário", "Complete seu primeiro desafio diário.", "📅", "common"],
  ["first_win", "Primeira Vitória", "Vença sua primeira partida.", "🥇", "common"],
  ["invicto_3", "Invicto", "Vença 3 partidas seguidas.", "🛡️", "rare"],
  ["maior_enganador", "Maior Enganador", "Engane 5 ou mais jogadores numa única partida.", "🦊", "rare"],
  ["partidas_10", "Veterano", "Jogue 10 partidas multiplayer.", "🎖️", "common"],
  ["social_butterfly", "Borboleta Social", "Jogue com 10 oponentes diferentes.", "🦋", "epic"],
  ["streak_3", "Em Chamas", "Jogue 3 dias seguidos.", "🔥", "common"],
  ["streak_30", "Lenda do Verbete", "Jogue 30 dias seguidos.", "👑", "legendary"],
  ["streak_7", "Semana Perfeita", "Jogue 7 dias seguidos.", "⚡", "rare"],
  ["truth_seeker", "Caçador da Verdade", "Acerte a definição verdadeira 10 vezes.", "🔍", "common"],
];

async function perfil(page: Page) {
  const b = homeBackend(true);
  // Nenhum e-mail na captura (nem fictício): a linha do e-mail fica vazia.
  b.user = { id: USER_ID, name: "Bia", email: "" };
  // Coerente com a fixture (23 partidas, 9 vitórias, sequência 5, melhor 12) e com as
  // conquistas abaixo: 1.450 XP = nível 4 (xp_to_level: floor(sqrt(xp/100)) + 1);
  // 31 acertos (≥ 10 → Caçador da Verdade), 27 enganados (< 100), recorde 18 (< 30).
  Object.assign(b.tables["user_stats"][0] as Record<string, unknown>, {
    xp: 1450,
    level: 4,
    total_score: 214,
    best_match_score: 18,
    total_truth_hits: 31,
    total_fooled: 27,
  });
  b.tables["profiles"] = [
    { user_id: USER_ID, display_name: "Bia", avatar: "🦊", color: "#FF5C8A" },
  ];
  b.tables["achievements"] = CATALOGO.map(
    ([code, name, description, emoji, rarity]) => ({ code, name, description, emoji, rarity }),
  );
  b.tables["user_achievements"] = [
    "first_win",
    "first_daily",
    "partidas_10",
    "streak_3",
    "streak_7",
    "truth_seeker",
  ].map((c) => ({ user_id: USER_ID, achievement_code: c }));
  // Últimas partidas (fictícias, coerentes com as estatísticas: a vitória de 13 pts é a do pódio 07).
  b.tables["match_history"] = [
    ["m-1", "4827", 13, 1, 6, "2026-11-20T21:40:00Z"],
    ["m-2", "5130", 9, 2, 5, "2026-11-19T22:05:00Z"],
    ["m-3", "2264", 11, 1, 4, "2026-11-18T20:30:00Z"],
  ].map(([id, room_code, final_score, position, players_count, played_at]) => ({
    id, user_id: USER_ID, room_code, final_score, position, players_count, played_at,
  }));
  const log = await installSupabaseMock(page, b);
  await prepare(page, {});
  await page.goto("/profile");
  await expect(
    page.getByText("Toque em uma conquista para saber como desbloqueá-la."),
  ).toBeVisible({ timeout: 25_000 });
  await entradaConcluida(page);
  return log;
}

const SHOTS: Array<{
  file: string;
  run: (page: Page) => Promise<{ aborted: unknown[] } | void>;
}> = [
  {
    file: "01-blefe",
    run: async (page) => {
      const log = await room(page, "writing");
      const ta = page.getByPlaceholder("escreva sua definicao mirabolante...");
      await expect(ta).toBeVisible({ timeout: 25_000 });
      // O jogador digitando (sem enviar). Frase que não precisa de acento.
      await ta.fill("passo de baile em que os pares trocam de lugar a cada volta");
      await page.waitForTimeout(1200);
      return log;
    },
  },
  {
    file: "alt-01-blefe-enviada",
    run: async (page) => {
      const backend = roomBackendSemIa("writing", { loggedIn: false });
      const rpc = backend.rpc as unknown as Record<string, { definitions: unknown[] }>;
      const row = (n: number, player_id: string) => ({
        id: `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        room_id: "6f2c1b0e-3d4a-4c5b-9e8f-1a2b3c4d5e6f",
        round: 3,
        player_id,
        text: "",
        letter: null,
      });
      for (const k of ["get_room_state", "get_round_sync"])
        rpc[k].definitions.push(row(303, "p_bia01"), row(305, "p_nina5"));
      const log = await installSupabaseMock(page, backend);
      await prepare(page, roomStorage("writing"));
      await page.goto(`/room/${ROOM_CODE}`);
      await expect(page.getByText("Definição enviada!", { exact: false })).toBeVisible({ timeout: 25_000 });
      await page.waitForTimeout(1500);
      return log;
    },
  },
  {
    file: "02-votacao",
    run: async (page) => {
      const log = await room(page, "voting");
      await expect(page.getByText("tambor de couro", { exact: false })).toBeVisible({ timeout: 25_000 });
      await page.waitForTimeout(1500);
      return log;
    },
  },
  {
    file: "03-diario",
    run: async (page) => {
      const b = dailyBackend("play");
      b.rpc.get_my_daily_review = { played: false, daily_mode: "escolha" } as never;
      const log = await installSupabaseMock(page, b);
      await page.route(
        (u) => u.pathname.startsWith("/_serverFn/"),
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: { "x-tss-serialized": "true" },
            body: JSON.stringify(
              toCrossJSON(
                {
                  result: {
                    status: "ok",
                    word: "alvíssaras",
                    category: "comportamento",
                    options: OPCOES,
                    elapsedS: 0,
                    hour: "2026-11-21T15:00:00.000Z",
                  },
                },
                { refs: new Map() },
              ),
            ),
          }),
      );
      await prepare(page, {});
      await page.goto("/daily");
      await page.getByRole("button", { name: /Ver alternativas/ }).click({ timeout: 30_000 });
      await expect(page.getByRole("radio")).toHaveCount(4);
      await page.getByRole("radio", { name: /Prêmio dado/ }).click();
      await page.waitForTimeout(1500);
      return log;
    },
  },
  {
    file: "04-home",
    run: async (page) => {
      const log = await installSupabaseMock(page, homeBackend(false));
      await prepare(page, {});
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Verbete" })).toBeVisible({ timeout: 25_000 });
      await expect(page.getByTestId("app-version")).toHaveText("v2.1.6");
      await entradaConcluida(page);
      await page.waitForTimeout(800);
      return log;
    },
  },
  {
    file: "05-multiplayer",
    run: async (page) => {
      const log = await room(page, "lobby");
      await expect(page.getByText("Jogadores (4/12)")).toBeVisible({ timeout: 25_000 });
      await page.waitForTimeout(1500);
      return log;
    },
  },
  {
    file: "06-revelacao",
    run: async (page) => {
      const log = await room(page, "reveal");
      await expect(page.getByText("A definição verdadeira", { exact: false }).first()).toBeVisible({ timeout: 25_000 });
      await expect(page.getByText("📊 Placar em").first()).toBeVisible({ timeout: 25_000 });
      await page.waitForTimeout(1200);
      return log;
    },
  },
  {
    // Pódio REAL do fim de jogo (mesma escolha de 11/11).
    file: "07-placar",
    run: async (page) => {
      const log = await room(page, "finished", { loggedIn: true });
      await expect(page.getByText("Fim de jogo", { exact: false }).first()).toBeVisible({ timeout: 25_000 });
      await page.waitForTimeout(3500);
      return log;
    },
  },
  {
    file: "alt-07-placar-rodada",
    run: async (page) => {
      const log = await room(page, "scoreboard");
      await expect(page.getByText("Acertou a verdade", { exact: false }).first()).toBeVisible({ timeout: 25_000 });
      await page.waitForTimeout(5500);
      return log;
    },
  },
  {
    // Perfil: nível/XP no topo e a grade de conquistas, com o "como desbloquear" aberto.
    file: "08-conquistas",
    run: async (page) => {
      const log = await perfil(page);
      // Enquadra da sequência (🔥) até as últimas partidas: grade + cartão aberto, sem a zona de perigo.
      // O cartão da sequência começa 14 px abaixo do topo; confere que nada fica cortado nas bordas.
      const enquadre = await page.getByText(/STREAK ATUAL/i).evaluate((el) => {
        // sobe até o cartão: o 1º ancestral com altura ≥ 60 px (o texto sozinho tem ~16 px)
        let card: HTMLElement = el as HTMLElement;
        while (card.parentElement && card.getBoundingClientRect().height < 60) card = card.parentElement;
        // instant: o app usa rolagem suave e a medida sairia no meio da animação. A página rola
        // num contêiner próprio (não na janela): ajusta os 16 px no contêiner que rola.
        card.scrollIntoView({ block: "start", behavior: "instant" });
        let sc: HTMLElement | null = card.parentElement;
        while (sc && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY)))
          sc = sc.parentElement;
        (sc ?? (document.scrollingElement as HTMLElement)).scrollBy({ top: -16, behavior: "instant" });
        const perigo = [...document.querySelectorAll("*")].find((n) => /^⚠️?\s*Zona de perigo$/i.test((n as HTMLElement).innerText ?? ""));
        return {
          topoCartao: Math.round(card.getBoundingClientRect().top),
          perigo: perigo ? Math.round(perigo.getBoundingClientRect().top) : null,
          altura: window.innerHeight,
        };
      });
      console.log("enquadre 08:", JSON.stringify(enquadre));
      await page.waitForTimeout(400);
      const alvo = page.getByRole("button", { name: "Semana Perfeita: conquistada" });
      await alvo.click();
      await expect(page.locator("[role=dialog][data-state=open]")).toContainText("Jogue 7 dias seguidos.");
      await page.waitForTimeout(900);
      return log;
    },
  },
  {
    file: "alt-08-perfil-topo",
    run: async (page) => {
      const log = await perfil(page);
      await page.waitForTimeout(800);
      return log;
    },
  },
];

for (const s of SHOTS) {
  test(s.file, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const log = await s.run(page);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() =>
        ["Fredoka", "Nunito"].map((fam) =>
          [...document.fonts].some((f) => f.family.replace(/['"]/g, "") === fam && f.status === "loaded"),
        ),
      ),
      "fontes locais Fredoka/Nunito carregadas",
    ).toEqual([true, true]);
    expect(externos, "requisição a host externo").toEqual([]);
    if (!s.file.startsWith("01-blefe"))
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.waitForTimeout(600);
    expect(
      await page.evaluate(() => document.documentElement.classList.contains("light")),
      "tema claro aplicado",
    ).toBe(true);
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - window.innerWidth;
    });
    expect(overflow, "rolagem horizontal").toBeLessThanOrEqual(1);
    expect(errors, "erros de página").toEqual([]);
    if (log) expect(log.aborted, "chamada ao Supabase sem resposta simulada").toEqual([]);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, "🧠 de bônus na partida").not.toMatch(/chegou perto|🧠 \+/);
    expect(text, "menção a IA").not.toMatch(/\bIA\b|intelig[eê]ncia artificial|Gemini/i);
    expect(text, "texto sem acento da fixture").not.toMatch(/bajulacao|sertao/);
    expect(text, "e-mail na tela").not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text, "aviso de idade cobrindo a tela").not.toMatch(/autodeclaração/i);
    // Corte/sobreposição: registrados (soft) para a auditoria, não bloqueiam a foto.
    expect.soft(await truncatedTexts(page), "texto truncado").toEqual([]);
    expect.soft(await clippedByAncestors(page), "cortado por contêiner").toEqual([]);
    await page.screenshot({ path: `${RAW}/${s.file}.png`, animations: "disabled", caret: "hide" });
    if (s.file.startsWith("0"))
      expect.soft(await blockedButtons(page), "botão cortado/coberto").toEqual([]);
  });
}
