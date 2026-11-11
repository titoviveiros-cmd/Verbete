// B7 — página "Para pais e responsáveis" (/pais), ECA Digital (Lei
// 15.211/2025 art. 16; Lei 14.852/2024 art. 16 VI e VIII), 11/11/2026.
// Rota renderizada de verdade (router em memória) + regras do texto: só o que
// existe, nada de consentimento parental inventado, nome legal PENDENTE com o
// marcador que a trava de build do PR #63 reprova, e o link para /denuncias
// (PR #65) só quando a rota existe.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { Route as PaisRoute } from "@/routes/pais";
import { CONTACT_EMAIL } from "@/lib/legal";
import {
  PARENTS_DEVELOPER_NAME,
  PARENTS_PAGE_PATH,
  REPORTS_PAGE_PATH,
} from "@/lib/parents-page";
import { READING_PATHS, isReadingPath } from "@/lib/viewport";

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Fonte com espaços colapsados: o JSX quebra frases em várias linhas. */
const flat = (p: string) => read(p).replace(/\s+/g, " ");
/** Só o JSX/TS, sem os comentários (que citam o que NÃO existe). */
const code = (p: string) =>
  read(p)
    .replace(/^\s*\/\/[^\n]*\n/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\s+/g, " ");

afterEach(cleanup);

async function montar({ comDenuncias }: { comDenuncias: boolean }) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const filhos = [
    createRoute({
      getParentRoute: () => root,
      path: PARENTS_PAGE_PATH,
      component: PaisRoute.options.component,
    }),
  ];
  if (comDenuncias)
    filhos.push(
      createRoute({
        getParentRoute: () => root,
        path: REPORTS_PAGE_PATH,
        component: () => <p>denúncias</p>,
      }),
    );
  const router = createRouter({
    routeTree: root.addChildren(filhos),
    history: createMemoryHistory({ initialEntries: [PARENTS_PAGE_PATH] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  await screen.findByRole("heading", {
    level: 1,
    name: "Para pais e responsáveis",
  });
}

describe("rota /pais", () => {
  it("abre com as seis partes pedidas, em linguagem simples", async () => {
    await montar({ comDenuncias: false });
    for (const h of [
      "O que é o jogo",
      "Com quem a criança ou o adolescente interage",
      "O que é coletado",
      "Como denunciar",
      "Como excluir a conta",
      "Controles disponíveis",
      "Contato",
    ])
      expect(
        screen.getByRole("heading", { level: 2, name: h }),
      ).toBeInTheDocument();
    expect(screen.getByText(/13 anos ou mais/)).toBeInTheDocument();
    expect(screen.getByText(/Denunciar jogador/)).toBeInTheDocument();
    expect(
      screen.getByText(/Perfil → Zona de perigo → Excluir/),
    ).toBeInTheDocument();
  });

  it("contato: o e-mail oficial (constante) e o nome legal ainda PENDENTE", async () => {
    await montar({ comDenuncias: false });
    const mails = screen.getAllByRole("link", { name: CONTACT_EMAIL });
    expect(mails.length).toBeGreaterThan(0);
    for (const a of mails)
      expect(a.getAttribute("href")).toMatch(
        /^mailto:titoviveiros@hotmail\.com\?subject=/,
      );
    expect(
      screen.getByText(new RegExp(`Responsável pelo jogo: <PENDENTE`)),
    ).toBeInTheDocument();
  });

  it("sem a rota /denuncias (antes do #65): nenhum link quebrado, fica o caminho no jogo", async () => {
    await montar({ comDenuncias: false });
    expect(screen.queryByRole("link", { name: "Denúncias" })).toBeNull();
    expect(screen.getByText(/bandeira 🚩/)).toBeInTheDocument();
  });

  it("com a rota /denuncias (depois do #65): o link aparece", async () => {
    await montar({ comDenuncias: true });
    const link = screen.getByRole("link", { name: "Denúncias" });
    expect(link.getAttribute("href")).toBe(REPORTS_PAGE_PATH);
  });

  it("diz com todas as letras o que NÃO existe (nada de consentimento inventado)", async () => {
    await montar({ comDenuncias: false });
    expect(
      screen.getByText(
        /ainda não tem modo para pais, senha dos responsáveis, limite de tempo nem verificação de idade, e não pede autorização dos pais/,
      ),
    ).toBeInTheDocument();
  });
});

describe("regras do texto", () => {
  const page = code("src/routes/pais.tsx");

  it("não promete recurso que não existe", () => {
    for (const proibido of [
      /consentimento dos pais/i,
      /modo protegido/i,
      /\bPIN\b/,
      /verificamos a idade/i,
      /Family Link/i,
      /sala (trancada|privada|só por convite)/i,
      /aparecer no ranking público/i, // opt-in é do PR do B6, não deste
      /autoriza(ção|r) (dos|do) (pais|responsável)(?! para jogar\.)/i,
    ])
      expect(page, String(proibido)).not.toMatch(proibido);
  });

  it("nenhum e-mail escrito à mão (só CONTACT_EMAIL)", () => {
    expect(read("src/routes/pais.tsx")).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
  });

  it("nome legal: o marcador do #63 ('<PENDENTE'), para a trava de build reprovar", () => {
    // LEGAL_PENDING_MARK do PR #63 (src/lib/legal.ts e verify-web-bundle.mjs)
    expect(PARENTS_DEVELOPER_NAME.startsWith("<PENDENTE")).toBe(true);
    expect(page).toMatch(/\{PARENTS_DEVELOPER_NAME\}/);
  });

  it("é página de leitura (zoom livre) e está no rodapé, no Download e no sitemap", () => {
    expect(READING_PATHS).toContain(PARENTS_PAGE_PATH);
    expect(isReadingPath("/pais/")).toBe(true);
    expect(read("src/routes/pais.tsx")).toContain("READING_VIEWPORT,");
    expect(flat("src/routes/index.tsx")).toMatch(
      /<Link to="\/pais" className="underline hover:text-foreground"> Para pais <\/Link>/,
    );
    expect(flat("src/routes/download.tsx")).toMatch(
      /<Link to="\/pais" className="hover:text-foreground"> Para pais e responsáveis <\/Link>/,
    );
    expect(read("src/routes/sitemap[.]xml.tsx")).toMatch(
      /\$\{APP_URL\}\/pais`/,
    );
  });
});
