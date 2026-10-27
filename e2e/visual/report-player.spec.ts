// Denúncia de jogador — apelido ou comportamento (rodada 2A da conformidade
// Google Play). O link discreto "Denunciar jogador" fica no Lobby e no fim
// da partida e abre um modal com os OUTROS humanos da sala (nunca você,
// nunca bots). Só o id do jogador e o motivo vão à server function; a
// resposta simulada aqui é erro (o modal avisa e não finge sucesso).
// Backend simulado (supabase-mock): nada sai da máquina.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { installSupabaseMock } from "./supabase-mock";
import { ROOM_CODE, roomBackend, roomStorage, type Phase } from "./fixtures";

const AXE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

async function openRoom(page: Page, phase: Phase) {
  await installSupabaseMock(page, roomBackend(phase));
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, roomStorage(phase));
  await page.goto(`/room/${ROOM_CODE}`);
}

/** POSTs às server functions: guarda o corpo e responde erro. */
async function serverFns(page: Page) {
  const posts: string[] = [];
  await page.route(
    (u) => u.pathname.startsWith("/_serverFn/"),
    (route) => {
      if (route.request().method() === "POST")
        posts.push(route.request().postData() ?? "");
      return route.fulfill({ status: 500, body: "teste" });
    },
  );
  return posts;
}

test("Lobby: denunciar o apelido de outro humano envia só id + motivo", async ({
  page,
}) => {
  const posts = await serverFns(page);
  await openRoom(page, "lobby");
  await expect(page.getByText("Jogadores (4/12)")).toBeVisible({
    timeout: 25_000,
  });
  await page.getByRole("button", { name: "Denunciar jogador" }).click();
  const dialog = page.getByRole("dialog", { name: "Denunciar jogador" });
  await expect(dialog).toBeVisible();

  // só os outros humanos: Lara e Dudu (nem a Bia, que é você, nem o bot)
  const options = dialog.getByRole("radio");
  await expect(options).toHaveCount(2);
  await expect(dialog.getByText("Lara")).toBeVisible();
  await expect(dialog.getByText("Dudu")).toBeVisible();
  await expect(dialog.getByText("TioBlefe")).toHaveCount(0);
  await expect(dialog.getByText("Bia")).toHaveCount(0);

  // sem escolher ninguém, nada sai
  await dialog.getByRole("button", { name: "Enviar" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Escolha o jogador.");
  expect(posts).toEqual([]);

  // acessibilidade do modal (WCAG 2.1 AA)
  await page.addScriptTag({ content: AXE });
  const violations = await page.evaluate(async () => {
    const w = window as unknown as {
      axe: {
        run: (
          ctx: Element,
          o: object,
        ) => Promise<{ violations: Array<{ id: string; nodes: unknown[] }> }>;
      };
    };
    const r = await w.axe.run(document.querySelector("[role='dialog']")!, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
  });
  expect(violations, "modal da denúncia").toEqual([]);

  await dialog.getByRole("radio", { name: /Dudu/ }).check();
  await dialog
    .getByLabel("Motivo:")
    .selectOption({ label: "Assédio, ameaça ou ofensa pessoal" });
  await dialog.getByRole("button", { name: "Enviar" }).click();
  await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
  expect(posts[0]).toContain("p_dudu2");
  expect(posts[0]).toContain("behavior");
  expect(posts[0]).not.toContain('Dudu"'); // o apelido vem do banco, não do cliente
  // resposta de erro: o modal avisa e fica aberto (não finge que registrou)
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByText(/Denúncia registrada/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toHaveCount(0);
});

test("fim da partida: o link também aparece e lista os outros humanos", async ({
  page,
}) => {
  await serverFns(page);
  await openRoom(page, "finished");
  const report = page.getByRole("button", { name: "Denunciar jogador" });
  await expect(report).toBeVisible({ timeout: 25_000 });
  await report.click();
  const dialog = page.getByRole("dialog", { name: "Denunciar jogador" });
  // Zé, Nina, Lara e Dudu — sem a Bia e sem o TioBlefe
  await expect(dialog.getByRole("radio")).toHaveCount(4);
  await expect(dialog.getByText("TioBlefe")).toHaveCount(0);
});
