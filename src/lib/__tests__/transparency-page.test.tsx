// Página "Transparência" (/transparencia) — Lei 14.852/2024 art. 16 IV; item
// 18 do B6 (16/11/2026). Rota renderizada de verdade (router em memória) +
// regras do texto: cada proteção citada é amarrada ao código que a sustenta,
// nenhum número inventado (só o compromisso semestral), link para /denuncias
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
  type AnyRoute,
} from "@tanstack/react-router";
import { Route as TransparenciaRoute } from "@/routes/transparencia";
import { CONTACT_EMAIL } from "@/lib/legal";
import {
  PARENTS_DEVELOPER_NAME,
  PARENTS_PAGE_PATH,
  REPORTS_PAGE_PATH,
} from "@/lib/parents-page";
import { READING_PATHS } from "@/lib/viewport";

const PATH = "/transparencia";
const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Só o JSX/TS, sem comentários, com espaços colapsados. */
const code = (p: string) =>
  read(p)
    .replace(/^\s*\/\/[^\n]*\n/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\s+/g, " ");

afterEach(cleanup);

async function montar({ comDenuncias }: { comDenuncias: boolean }) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const filhos: AnyRoute[] = [
    createRoute({
      getParentRoute: () => root,
      path: PATH,
      component: TransparenciaRoute.options.component,
    }),
    createRoute({
      getParentRoute: () => root,
      path: PARENTS_PAGE_PATH,
      component: () => <p>pais</p>,
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
    history: createMemoryHistory({ initialEntries: [PATH] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  await screen.findByRole("heading", { level: 1, name: "Transparência" });
}

describe("rota /transparencia", () => {
  it("abre com as partes do art. 16 IV (métodos, proteções, medidas, educação, números)", async () => {
    await montar({ comDenuncias: false });
    for (const h of [
      "Como moderamos",
      "Proteções que já existem",
      "Medidas e reincidência",
      "Dicas de segurança",
      "Números a cada seis meses",
      "Contato",
    ])
      expect(
        screen.getByRole("heading", { level: 2, name: h }),
      ).toBeInTheDocument();
    expect(
      screen.getByText(
        new RegExp(
          `Responsável pelo jogo: .*${PARENTS_DEVELOPER_NAME.replace(/[()]/g, "\\$&")}`,
        ),
      ),
    ).toBeInTheDocument();
    for (const a of screen.getAllByRole("link", { name: CONTACT_EMAIL }))
      expect(a.getAttribute("href")).toMatch(
        /^mailto:titoviveiros@hotmail\.com\?subject=/,
      );
    expect(
      screen
        .getByRole("link", { name: "Para pais e responsáveis" })
        .getAttribute("href"),
    ).toBe(PARENTS_PAGE_PATH);
  });

  it("link para /denuncias só quando a rota existe (PR #65)", async () => {
    await montar({ comDenuncias: false });
    expect(screen.queryByRole("link", { name: "Denúncias" })).toBeNull();
    cleanup();
    await montar({ comDenuncias: true });
    expect(
      screen.getByRole("link", { name: "Denúncias" }).getAttribute("href"),
    ).toBe(REPORTS_PAGE_PATH);
  });

  it("é página de leitura e está no sitemap e na /pais", () => {
    expect(READING_PATHS).toContain(PATH);
    expect(read("src/routes/sitemap[.]xml.tsx")).toContain("/transparencia");
    expect(code("src/routes/pais.tsx")).toMatch(/to="\/transparencia"/);
  });
});

describe("regras do texto", () => {
  const page = code("src/routes/transparencia.tsx");

  it("cada proteção citada existe no código", () => {
    const amarras: Array<[RegExp, string, RegExp]> = [
      [
        /o dono pode trancar a sala/,
        "src/lib/room-access.ts",
        /set_room_locked/,
      ],
      [
        /Jogar só com bots/,
        "src/components/room/phases/Lobby.tsx",
        /Jogar só com bots/,
      ],
      [
        /Não há sala aberta para desconhecidos/,
        "supabase/migrations/20261111140000_sala_trancada_partida_rapida.sql",
        /public_rooms_closed/,
      ],
      [
        /Aparecer no ranking público/,
        "src/components/RankingOptIn.tsx",
        /Aparecer no ranking público/,
      ],
      [
        /definições com palavrão, links ou contatos .* são recusadas/,
        "supabase/migrations/20261111120000_ugc_filtro_servidor.sql",
        /definitions_ugc_guard/,
      ],
      [
        /menos de 13 anos joga só com bots/,
        "src/lib/age.ts",
        /saveAgeDeclaration/,
      ],
      [
        /banir o aparelho e\/ou a conta, por um prazo ou de forma definitiva/,
        "supabase/migrations/20260518221956_e6e34506-9d6d-409a-bc61-35ee8525ce8e.sql",
        /expires_at timestamptz/,
      ],
    ];
    for (const [frase, arquivo, prova] of amarras) {
      expect(page, String(frase)).toMatch(frase);
      expect(read(arquivo), `${arquivo} ${prova}`).toMatch(prova);
    }
  });

  it("nenhum número inventado: só o compromisso semestral", () => {
    expect(page).toMatch(/a cada seis meses/);
    expect(page).not.toMatch(
      /\b\d+ (denúncias|banimentos|recursos|conteúdos)\b/,
    );
  });

  it("não promete recurso que não existe", () => {
    for (const proibido of [
      /consentimento dos pais/i,
      /modo protegido/i,
      /\bPIN\b/,
      /verificamos a idade/i,
      /inteligência artificial/i,
    ])
      expect(page, String(proibido)).not.toMatch(proibido);
  });

  it("nenhum e-mail escrito à mão (só CONTACT_EMAIL)", () => {
    expect(read("src/routes/transparencia.tsx")).not.toMatch(
      /@[a-z0-9-]+\.[a-z]/i,
    );
  });
});
