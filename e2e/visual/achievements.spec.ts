// Conquistas consultáveis no Perfil (18/11/2026), com o Supabase simulado:
// toque (celular emulado), mouse e teclado abrem o "como desbloquear" de
// qualquer conquista — inclusive bloqueada —, um cartão por vez, dentro da
// tela e sem gravar nada. Capturas em test-results/conquistas-*.png.
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock, type MockBackend } from "./supabase-mock";
import { USER_ID, homeBackend } from "./fixtures";

// Catálogo REAL (produção = migrations, conferido em 18/11/2026).
const CATALOGO = [
  [
    "acertos_100",
    "Mestre das Palavras",
    "Acerte a definição verdadeira 100 vezes.",
    "🧠",
    "epic",
  ],
  [
    "big_score",
    "Pontuação Massiva",
    "Faça 30+ pontos em uma única partida.",
    "💯",
    "epic",
  ],
  [
    "bluff_master",
    "Mestre do Blefe",
    "Receba 5+ votos em uma única definição falsa.",
    "🎭",
    "rare",
  ],
  [
    "bluffs_100",
    "Professor do Blefe",
    "Engane jogadores 100 vezes com suas definições.",
    "🎓",
    "epic",
  ],
  ["coordinator_5", "Coordenador Nato", "Coordene 5 rodadas.", "🎯", "rare"],
  [
    "first_daily",
    "Estreante Diário",
    "Complete seu primeiro desafio diário.",
    "📅",
    "common",
  ],
  [
    "first_win",
    "Primeira Vitória",
    "Vença sua primeira partida.",
    "🥇",
    "common",
  ],
  ["invicto_3", "Invicto", "Vença 3 partidas seguidas.", "🛡️", "rare"],
  [
    "maior_enganador",
    "Maior Enganador",
    "Engane 5 ou mais jogadores numa única partida.",
    "🦊",
    "rare",
  ],
  ["partidas_10", "Veterano", "Jogue 10 partidas multiplayer.", "🎖️", "common"],
  [
    "social_butterfly",
    "Borboleta Social",
    "Jogue com 10 oponentes diferentes.",
    "🦋",
    "epic",
  ],
  ["streak_3", "Em Chamas", "Jogue 3 dias seguidos.", "🔥", "common"],
  [
    "streak_30",
    "Lenda do Verbete",
    "Jogue 30 dias seguidos.",
    "👑",
    "legendary",
  ],
  ["streak_7", "Semana Perfeita", "Jogue 7 dias seguidos.", "⚡", "rare"],
  [
    "truth_seeker",
    "Caçador da Verdade",
    "Acerte a definição verdadeira 10 vezes.",
    "🔍",
    "common",
  ],
].map(([code, name, description, emoji, rarity]) => ({
  code,
  name,
  description,
  emoji,
  rarity,
}));

function backend(): MockBackend {
  const b = homeBackend(true);
  b.tables["profiles"] = [
    { user_id: USER_ID, display_name: "Bia", avatar: "🦊", color: "#FF5C8A" },
  ];
  b.tables["achievements"] = CATALOGO;
  b.tables["user_achievements"] = [
    { user_id: USER_ID, achievement_code: "first_win" },
    { user_id: USER_ID, achievement_code: "first_daily" },
  ];
  return b;
}

/** Abre o Perfil e devolve as escritas (POST/PATCH/DELETE) que saírem. */
async function abrirPerfil(page: Page) {
  await installSupabaseMock(page, backend());
  const escritas: string[] = [];
  page.on("request", (r) => {
    if (["POST", "PATCH", "DELETE", "PUT"].includes(r.method()))
      escritas.push(`${r.method()} ${r.url()}`);
  });
  await page.goto("/profile");
  await expect(
    page.getByText("Toque em uma conquista para saber como desbloqueá-la."),
  ).toBeVisible({ timeout: 25_000 });
  escritas.length = 0; // só conta o que acontecer ao CONSULTAR
  return escritas;
}

/** Só o cartão ABERTO (o anterior pode estar na animação de saída, data-state=closed). */
const aberto = (page: Page) => page.locator("[role=dialog][data-state=open]");

async function dentroDaTela(page: Page) {
  const caixa = await aberto(page).boundingBox();
  const vp = page.viewportSize();
  expect(caixa && vp).toBeTruthy();
  expect(caixa!.x).toBeGreaterThanOrEqual(0);
  expect(caixa!.y).toBeGreaterThanOrEqual(0);
  expect(caixa!.x + caixa!.width).toBeLessThanOrEqual(vp!.width);
  expect(caixa!.y + caixa!.height).toBeLessThanOrEqual(vp!.height);
}

test.describe("celular (toque)", () => {
  test.use({
    viewport: { width: 360, height: 740 },
    hasTouch: true,
    isMobile: true,
  });

  test("um toque abre bloqueada e conquistada; troca; fecha fora e no ✕; nada é gravado", async ({
    page,
  }) => {
    const escritas = await abrirPerfil(page);
    // bloqueada na borda direita da grade (5ª coluna)
    const coord = page.getByRole("button", {
      name: "Coordenador Nato: ainda não conquistada",
    });
    await coord.scrollIntoViewIfNeeded();
    await coord.tap();
    const cartao = aberto(page);
    await expect(cartao).toBeVisible();
    await expect(cartao).toContainText("Coordenador Nato");
    await expect(cartao).toContainText("Ainda não conquistada");
    await expect(cartao).toContainText("Coordene 5 rodadas.");
    await dentroDaTela(page);
    // legível: opacidade efetiva 1 (não herdou a do ícone). Espera a animação de entrada
    // (fade-in) terminar — no CI, mais lento, ela ainda estava em 0,85 na 1ª leitura.
    await expect
      .poll(() =>
        cartao.evaluate((el) => {
          let o = 1;
          for (let n: Element | null = el; n; n = n.parentElement)
            o *= Number(getComputedStyle(n).opacity);
          return o;
        }),
      )
      .toBe(1);
    await page.screenshot({
      path: "test-results/conquistas-celular-bloqueada.png",
    });

    // troca: só um cartão
    await page
      .getByRole("button", { name: "Primeira Vitória: conquistada" })
      .tap();
    await expect(aberto(page)).toHaveCount(1);
    await expect(aberto(page)).toContainText("Conquistada");
    await expect(aberto(page)).toContainText("Vença sua primeira partida.");
    await dentroDaTela(page);
    await page.screenshot({
      path: "test-results/conquistas-celular-conquistada.png",
    });

    // toque fora fecha
    await page.getByRole("heading", { name: "Últimas partidas" }).tap();
    await expect(aberto(page)).toHaveCount(0);
    // ✕ fecha
    await page
      .getByRole("button", { name: "Lenda do Verbete: ainda não conquistada" })
      .tap();
    await aberto(page).getByRole("button", { name: "Fechar" }).tap();
    await expect(aberto(page)).toHaveCount(0);

    expect(escritas, "consultar conquista gravou algo").toEqual([]);
  });
});

test.describe("computador (mouse e teclado)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("mouse abre ao passar, mantém sobre o cartão, clique fixa; teclado abre no foco e Escape fecha", async ({
    page,
  }) => {
    const escritas = await abrirPerfil(page);
    const alvo = page.getByRole("button", {
      name: "Mestre do Blefe: ainda não conquistada",
    });
    await alvo.scrollIntoViewIfNeeded();
    await alvo.hover();
    const cartao = aberto(page);
    await expect(cartao).toContainText(
      "Receba 5+ votos em uma única definição falsa.",
    );
    // do ícone para o texto do cartão: continua aberto
    await cartao.getByText("Como desbloquear").hover();
    await page.waitForTimeout(500);
    await expect(cartao).toBeVisible();
    await page.screenshot({
      path: "test-results/conquistas-computador-mouse.png",
    });
    // sair fecha
    await page.mouse.move(5, 5);
    await expect(aberto(page)).toHaveCount(0);
    // clique fixa: sair não fecha
    await alvo.click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(500);
    await expect(aberto(page)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(aberto(page)).toHaveCount(0);

    // teclado: foco abre, Escape fecha
    await page
      .getByRole("button", { name: "Veterano: ainda não conquistada" })
      .focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(aberto(page)).toContainText("Veterano");
    await page.keyboard.press("Escape");
    await expect(aberto(page)).toHaveCount(0);

    expect(escritas, "consultar conquista gravou algo").toEqual([]);
  });
});
