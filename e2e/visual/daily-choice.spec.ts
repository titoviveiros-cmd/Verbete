// Diário D1 — modo ESCOLHA (múltipla escolha, sem IA): tela real no navegador,
// com o Supabase E as server functions simulados (nada sai da máquina).
// Critérios 1–3 no app de verdade: "Escolha a definição correta", 4
// alternativas, só certo/errado + a correta, sem juiz/nota/semelhança/%/IA.
import { expect, test, type Page } from "@playwright/test";
import { toCrossJSON } from "seroval";
import { installSupabaseMock } from "./supabase-mock";
import { dailyBackend } from "./fixtures";

const PROIBIDO =
  /juiz|\bnota\b|semelhan|%|IA avaliou|intelig[eê]ncia artificial/i;
const OPTIONS = [
  { pos: 0, text: "Castigo aplicado em público, na praça" },
  { pos: 1, text: "Prêmio dado a quem traz boas notícias" },
  { pos: 2, text: "Moeda antiga de pouco valor, de cobre" },
  { pos: 3, text: "Pequena caixa de madeira para joias" },
];

/** Resposta no protocolo das server functions (seroval + marca x-tss-serialized). */
function serverFnBody(result: unknown) {
  return JSON.stringify(toCrossJSON({ result }, { refs: new Map() }));
}

async function mockChoice(page: Page, opts: { correct: boolean }) {
  const posts: string[] = [];
  await page.route(
    (u) => u.pathname.startsWith("/_serverFn/"),
    (route) => {
      const body = route.request().postData() ?? "";
      posts.push(body);
      const result = body.includes("pos")
        ? {
            already_played: false,
            is_correct: opts.correct,
            score: opts.correct ? 46 : 0,
            truth: OPTIONS[1]!.text,
            chosen: opts.correct ? OPTIONS[1]!.text : OPTIONS[2]!.text,
            correct_pos: 1,
            chosen_pos: opts.correct ? 1 : 2,
            time_seconds: 8,
            current_streak: 2,
            unlocked: [],
          }
        : {
            status: "ok",
            word: "alvíssaras",
            category: "comportamento",
            options: OPTIONS,
            elapsedS: 0,
            hour: "2026-11-08T16:00:00.000Z",
          };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serverFnBody(result),
      });
    },
  );
  return posts;
}

function backend(review: Record<string, unknown>) {
  const b = dailyBackend("play");
  b.rpc.get_my_daily_review = review as never;
  return b;
}

test("modo escolha: abrir, escolher, confirmar e ver o acerto — sem IA na tela", async ({
  page,
}) => {
  const log = await installSupabaseMock(
    page,
    backend({ played: false, daily_mode: "escolha" }),
  );
  const posts = await mockChoice(page, { correct: true });
  await page.goto("/daily");
  await expect(
    page.getByText("Escolha a definição correta").first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: /Ver alternativas/ }),
  ).toBeVisible();
  await expect(page.locator("#daily-guess")).toHaveCount(0); // nada de caixa de texto do modo juiz
  // Red Team A1: a palavra NÃO aparece antes de abrir as alternativas (o relógio começa no abrir)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("?");
  await expect(page.getByText("alvíssaras", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: /Ver alternativas/ }).click();
  // A2: a palavra exibida é a que veio do servidor junto com as alternativas
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /alvíssaras/i,
  );
  await expect(page.getByRole("radio")).toHaveCount(4);
  expect(await page.locator("main, body").first().innerText()).not.toMatch(
    PROIBIDO,
  );
  await page.screenshot({
    path: "test-results/diario-escolha-alternativas.png",
  });
  await page.getByRole("radio", { name: /Prêmio dado/ }).click();
  await page.getByRole("button", { name: /Confirmar resposta/ }).click();
  await expect(page.getByText("Acertou!")).toBeVisible();
  await expect(page.getByText(/\+46/)).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(PROIBIDO);
  await page.screenshot({ path: "test-results/diario-escolha-acertou.png" });
  expect(posts).toHaveLength(2); // abrir + responder, nada mais
  expect(posts[1]).toContain("pos");
  expect(posts.join(" ")).not.toMatch(/timeSeconds|time_seconds/);
  // nenhuma chamada a provedor de IA nem à edge function do juiz
  expect(
    log.calls.filter((c) =>
      /functions\/v1|generativelanguage|anthropic|openai/i.test(c),
    ),
  ).toEqual([]);
});

test("modo escolha: errou → 'Era esta' com a correta, sem medidor nem nota", async ({
  page,
}) => {
  await installSupabaseMock(
    page,
    backend({ played: false, daily_mode: "escolha" }),
  );
  await mockChoice(page, { correct: false });
  await page.goto("/daily");
  await page
    .getByRole("button", { name: /Ver alternativas/ })
    .click({ timeout: 30_000 });
  await page.getByRole("radio", { name: /Moeda antiga/ }).click();
  await page.getByRole("button", { name: /Confirmar resposta/ }).click();
  await expect(page.getByText("Não foi dessa vez")).toBeVisible();
  await expect(page.getByText(/Era esta/)).toBeVisible();
  await expect(page.locator(".meter")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(PROIBIDO);
  await page.screenshot({ path: "test-results/diario-escolha-errou.png" });
});

test("modo escolha: já jogou na hora → resultado da escolha, sem 'Semelhança'", async ({
  page,
}) => {
  await installSupabaseMock(
    page,
    backend({
      played: true,
      daily_mode: "escolha",
      attempt: {
        guess: OPTIONS[1]!.text,
        is_correct: true,
        score: 44,
        time_seconds: 12,
        similarity: 0,
        challenge_hour: "2026-10-18T15:00:00Z",
        mode: "escolha",
      },
      truth: OPTIONS[1]!.text,
      word: "alvíssaras",
    }),
  );
  await page.goto("/daily");
  await expect(page.getByText("Acertou!")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Semelhança")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(PROIBIDO);
});

test("pausa: aviso sem formulário e sem tentativa gasta", async ({ page }) => {
  await installSupabaseMock(
    page,
    backend({ played: false, daily_mode: "pausa" }),
  );
  await page.goto("/daily");
  await expect(page.getByText("Desafio em pausa")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/NÃO foi gasta/)).toBeVisible();
  await expect(page.locator("#daily-guess")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Ver alternativas/ }),
  ).toHaveCount(0);
});

test("modo juiz (padrão, servidor sem daily_mode): a tela de sempre, sem o modo escolha", async ({
  page,
}) => {
  await installSupabaseMock(page, dailyBackend("play"));
  await page.goto("/daily");
  await expect(page.locator("#daily-guess")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: /Ver alternativas/ }),
  ).toHaveCount(0);
});
