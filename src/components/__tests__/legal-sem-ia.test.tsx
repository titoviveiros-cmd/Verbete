import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Modo "sem IA externa" (13+, 10/11/2026; docs/sem-ia-externa.md).
// 1) Hoje (EXTERNAL_AI_MODE = "ligada") NADA muda: provedor, Termos 2026-10-27,
//    páginas com a seção de IA, sem nome do desenvolvedor.
// 2) Com "desligada": corte por código (AI_PROVIDERS_DISCLOSED = [] → IA
//    suspensa com a chave presente), páginas sem IA, nome legal e UM novo
//    aceite (TERMS_VERSION = NO_AI_TERMS_VERSION).
// 3) Trava: com "desligada", nome/data pendentes reprovam o check, o build de
//    produção (vite.config) e a verificação do bundle.

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ options: opts }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/lib/player-id", () => ({
  getStored: () => "",
  setStored: vi.fn(),
}));

const EXTERNAL_AI = "../../../supabase/functions/_shared/external-ai.ts";
const ROOT = resolve(__dirname, "../../..");

afterEach(() => {
  cleanup();
  vi.doUnmock(EXTERNAL_AI);
  vi.resetModules();
});

/** Recarrega o grafo de módulos com o interruptor no valor pedido. */
async function withMode(mode: "ligada" | "desligada") {
  vi.resetModules();
  vi.doMock(EXTERNAL_AI, () => ({
    EXTERNAL_AI_MODE: mode,
    isExternalAiOff: (m: string = mode) => m === "desligada",
  }));
  const legal = await import("@/lib/legal");
  const terms = await import("@/lib/terms-record");
  const provider =
    await import("../../../supabase/functions/_shared/ai-provider.ts");
  const aiMode = await import("../../../supabase/functions/_shared/ai-mode.ts");
  return { legal, terms, provider, aiMode };
}

type Routed = { options: { component: ComponentType } };
const ROUTES = {
  privacy: () => import("@/routes/privacy"),
  terms: () => import("@/routes/terms"),
  support: () => import("@/routes/support"),
  deleteAccount: () => import("@/routes/delete-account"),
};
async function page(name: keyof typeof ROUTES) {
  const mod = (await ROUTES[name]()) as { Route: unknown };
  const Page = (mod.Route as Routed).options.component;
  render(<Page />);
  return document.body.textContent ?? "";
}
const flat = (s: string) => s.replace(/\s+/g, " ");

const GEMINI_ENV: Record<string, string> = { GEMINI_API_KEY: "chave-teste" };
const env = (k: string) => GEMINI_ENV[k];

describe("estado do repositório — backend e textos sempre juntos", () => {
  // Vale nos dois modos: o PR de ativação muda só as 3 constantes.
  it("ligada = Gemini com texto legal e Termos 2026-10-27; desligada = nenhum provedor e Termos novos", async () => {
    const { EXTERNAL_AI_MODE } =
      await import("../../../supabase/functions/_shared/external-ai.ts");
    const {
      NO_AI_LEGAL,
      NO_AI_TERMS_VERSION,
      pendingNoAiLegal,
      AI_TERMS_VERSION,
    } = await import("@/lib/legal");
    const { TERMS_VERSION } = await import("@/lib/terms-record");
    const { AI_PROVIDERS_DISCLOSED, resolveAiProvider } =
      await import("../../../supabase/functions/_shared/ai-provider.ts");
    expect(AI_TERMS_VERSION).toBe("2026-10-27");
    expect(pendingNoAiLegal()).toEqual([]);
    if (EXTERNAL_AI_MODE === "ligada") {
      expect(NO_AI_LEGAL).toBeNull();
      expect(TERMS_VERSION).toBe(AI_TERMS_VERSION);
      expect(AI_PROVIDERS_DISCLOSED).toEqual(["gemini"]);
      expect(resolveAiProvider(env).ok).toBe(true);
    } else {
      expect(EXTERNAL_AI_MODE).toBe("desligada");
      expect(NO_AI_LEGAL?.termsVersion).toBe(NO_AI_TERMS_VERSION);
      expect(TERMS_VERSION).toBe(NO_AI_TERMS_VERSION);
      expect(TERMS_VERSION > AI_TERMS_VERSION).toBe(true);
      expect(AI_PROVIDERS_DISCLOSED).toEqual([]);
      expect(resolveAiProvider(env).ok).toBe(false);
    }
  });

  it("páginas com a IA ligada: textos de sempre, sem nome do desenvolvedor", async () => {
    await withMode("ligada");
    const p = flat(await page("privacy"));
    expect(p).toContain("Inteligência artificial (Google Gemini)");
    expect(p).toContain("Última atualização: 8 de novembro de 2026");
    expect(p).toMatch(/Google Gemini: a inteligência artificial descrita/);
    expect(p).not.toMatch(/desenvolvido e mantido por/);
    cleanup();
    const t = flat(await page("terms"));
    expect(t).toContain("Última atualização: 27 de outubro de 2026");
    expect(t).toContain("5. Inteligência artificial");
    expect(t).toContain(
      "processá-lo — inclusive pela inteligência artificial, como descrito acima — e usá-lo",
    );
    expect(t).not.toMatch(/Estes Termos valem entre/);
    cleanup();
    const s = flat(await page("support"));
    expect(s).toMatch(/ganha o bônus 🧠/);
    expect(s).toMatch(/No modo de escrita/);
    expect(s).not.toMatch(/O Verbete usa inteligência artificial\?/);
    cleanup();
    const d = flat(await page("deleteAccount"));
    expect(d).toMatch(/contagem de avaliações/);
  });
});

describe("modo 'desligada': corte por código", () => {
  it("nenhum provedor com texto legal → IA suspensa mesmo com a chave e sem ai_mode", async () => {
    const { provider, aiMode } = await withMode("desligada");
    expect(provider.disclosedProvidersFor("desligada")).toEqual([]);
    expect(provider.AI_PROVIDERS_DISCLOSED).toEqual([]);
    // o perfil em si continua válido (o adaptador fica dormente)…
    expect(provider.resolveAiProviderProfile(env).ok).toBe(true);
    // …mas sem texto legal o resultado é inválido e a contenção suspende
    const r = provider.resolveAiProvider(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.undisclosed).toBe(true);
    expect(aiMode.forcedSuspensionFrom(env)).toBe(true);
    const load = vi.fn(async () => "ligado");
    const read = aiMode.createAiModeReader({
      forced: () => aiMode.forcedSuspensionFrom(env),
    });
    expect(await read(load)).toBe("suspenso");
    expect(load).not.toHaveBeenCalled();
  });

  it("com a IA ligada a mesma chave segue funcionando (prova do contrário)", async () => {
    const { provider, aiMode } = await withMode("ligada");
    expect(provider.disclosedProvidersFor("ligada")).toEqual(["gemini"]);
    expect(aiMode.forcedSuspensionFrom(env)).toBe(false);
  });
});

describe("modo 'desligada': textos legais e de jogo", () => {
  it("Termos: versão nova = data sem IA (UM novo aceite), §5 sem IA, licença sem IA, nome legal", async () => {
    const { legal, terms } = await withMode("desligada");
    expect(terms.TERMS_VERSION).toBe(legal.NO_AI_TERMS_VERSION);
    expect(terms.TERMS_VERSION).not.toBe(legal.AI_TERMS_VERSION);
    const t = flat(await page("terms"));
    expect(t).toContain(
      `Última atualização: ${legal.formatLegalDate(terms.TERMS_VERSION)}`,
    );
    expect(t).toContain(
      `Estes Termos valem entre você e ${legal.DEVELOPER_LEGAL_NAME}`,
    );
    expect(t).toContain("5. Sem inteligência artificial externa");
    expect(t).toMatch(/não usa serviços externos de inteligência artificial/);
    expect(t).not.toMatch(/criadas por inteligência artificial/);
    expect(t).not.toMatch(/inclusive pela inteligência artificial/);
    expect(t).not.toMatch(/Gemini|bônus 🧠/);
    expect(t).toContain("processá-lo e usá-lo na moderação");
    // o resto dos Termos (UGC, idade, denúncia) continua igual
    for (const keep of [
      "Recomendado para 13 anos ou mais",
      "bandeira 🚩",
      "Denunciar jogador",
      "licença gratuita e não exclusiva",
    ])
      expect(t).toContain(keep);
  });

  it("Privacidade: sem envio à IA, provedor fora de 'Quem processa', nome legal, histórico transparente", async () => {
    const { legal } = await withMode("desligada");
    const p = flat(await page("privacy"));
    expect(p).toContain(
      `desenvolvido e mantido por ${legal.DEVELOPER_LEGAL_NAME}`,
    );
    expect(p).toMatch(/não usa serviços externos de inteligência artificial/);
    expect(p).not.toMatch(/Inteligência artificial \(Google Gemini\)/);
    expect(p).not.toMatch(/Google Gemini: a inteligência artificial/);
    expect(p).not.toMatch(/avaliar por inteligência artificial|bônus 🧠/);
    expect(p).not.toMatch(/plano gratuito/);
    // o que foi enviado ANTES da mudança continua explicado
    expect(p).toMatch(/Antes dessa mudança/);
    // Red Team do PR #63 (P2): nada de prometer a origem "acervo" (há
    // alternativas sem fonte no acervo)
    expect(p).not.toMatch(/acervo/);
    expect(p).toMatch(
      /As definições dos bots e as opções do Desafio Diário vêm de textos prontos do próprio jogo/,
    );
    // fatos que não dependem da IA continuam
    for (const keep of [
      "Supabase:",
      "Cloudflare:",
      "13 anos ou mais",
      "apagados automaticamente depois de 3 dias",
      "identificadores técnicos",
    ])
      expect(p).toContain(keep);
    expect(p).toContain(
      `Última atualização: ${legal.formatLegalDate(legal.NO_AI_TERMS_VERSION)}`,
    );
  });

  it("Suporte: sem 🧠, Desafio só de múltipla escolha, pergunta direta sobre IA", async () => {
    await withMode("desligada");
    const s = flat(await page("support"));
    expect(s).not.toMatch(/🧠|modo de escrita|avaliação automática/);
    expect(s).toMatch(/O Verbete usa inteligência artificial\?/);
    expect(s).toMatch(/Você escolhe a definição correta entre quatro/);
    expect(s).toMatch(/De 4 a 12/);
  });

  it("Excluir conta: resíduos do antigo modo de escrita expiram em 3 dias; os da múltipla escolha saem com a conta", async () => {
    await withMode("desligada");
    const d = flat(await page("deleteAccount"));
    expect(d).toMatch(/antigo modo de escrita do Desafio Diário/);
    expect(d).toMatch(/limite de uso/);
    expect(d).toMatch(/expiram sozinhos em 3 dias/);
    // daily_choice_sessions: FK ON DELETE CASCADE (migration D1)
    expect(d).toMatch(/múltipla escolha saem junto com a conta/);
    const m = readFileSync(
      resolve(ROOT, "supabase/migrations/20261108120000_diario_d1_escolha.sql"),
      "utf8",
    );
    expect(m).toMatch(
      /daily_choice_sessions \(\s*user_id\s+uuid\s+NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/,
    );
  });

  // (com a IA ligada, o texto de sempre: copy-sem-ia.test.tsx)
  // import novo do framer-motion depois do resetModules: prazo maior
  it("Como jogar: sem a linha do bônus 🧠", { timeout: 30_000 }, async () => {
    await withMode("desligada");
    const { Onboarding } = await import("@/components/Onboarding");
    render(<Onboarding onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Passo 4" }));
    await screen.findByRole("heading", { name: "Como ganhar pontos" });
    expect(document.body.textContent).not.toMatch(/🧠/);
    expect(document.body.textContent).toMatch(/\+1 ponto por voto recebido/);
  });
});

describe("trava do nome legal e da data (build de produção)", () => {
  it("com 'desligada', marcador pendente = item pendente; preenchido = pronto", async () => {
    const { pendingNoAiLegal } = await import("@/lib/legal");
    // os marcadores usados hoje no repositório (antes da ativação)
    expect(
      pendingNoAiLegal("desligada", {
        developerName: "<PENDENTE: confirmar com o dono>",
        termsVersion: "<PENDENTE: data da ativação AAAA-MM-DD>",
      }),
    ).toEqual(["DEVELOPER_LEGAL_NAME", "NO_AI_TERMS_VERSION"]);
    expect(
      pendingNoAiLegal("desligada", {
        developerName: "Nome Legal Exemplo",
        termsVersion: "2026-11-24",
      }),
    ).toEqual([]);
    expect(
      pendingNoAiLegal("desligada", {
        developerName: "  ",
        termsVersion: "2026-02-30",
      }),
    ).toEqual(["DEVELOPER_LEGAL_NAME", "NO_AI_TERMS_VERSION"]);
    expect(pendingNoAiLegal("ligada")).toEqual([]);
  });

  // Red Team do PR #63 (P2): estes nomes PASSAVAM na 1ª versão da trava
  // (só "<PENDENTE" e < 3 caracteres eram recusados).
  it.each([
    "PENDENTE: confirmar com o dono>",
    "pendente",
    "Fulano (Pendente)",
    "<a confirmar>",
    "Confirmar com o dono",
    "TODO",
    "Nome todo: definir",
    "Fulano <x>",
    "Fulano > Beltrano",
    "123",
    "   \t ",
    "ab",
  ])("nome implausível reprova: %j", async (name) => {
    const { pendingNoAiLegal, isPlausibleLegalName } =
      await import("@/lib/legal");
    expect(isPlausibleLegalName(name)).toBe(false);
    expect(
      pendingNoAiLegal("desligada", {
        developerName: name,
        termsVersion: "2026-11-24",
      }),
    ).toEqual(["DEVELOPER_LEGAL_NAME"]);
  });

  it.each(["Fulano de Tal", "Ana Lú", "Tito Viveiros ME", "J. P. Souza"])(
    "nome plausível passa: %j",
    async (name) => {
      const { isPlausibleLegalName } = await import("@/lib/legal");
      expect(isPlausibleLegalName(name)).toBe(true);
    },
  );

  // Red Team do PR #63 (P2): datas válidas iguais/anteriores aos Termos com
  // IA PASSAVAM — texto novo sem versão nova = mudança sem novo aceite.
  it.each(["2026-10-27", "2026-10-26", "2026-05-18", "2025-12-31"])(
    "data dos Termos sem IA igual ou anterior a 2026-10-27 reprova: %s",
    async (termsVersion) => {
      const { pendingNoAiLegal, AI_TERMS_VERSION } =
        await import("@/lib/legal");
      expect(termsVersion <= AI_TERMS_VERSION).toBe(true);
      expect(
        pendingNoAiLegal("desligada", {
          developerName: "Fulano de Tal",
          termsVersion,
        }),
      ).toEqual(["NO_AI_TERMS_VERSION"]);
    },
  );

  it("data posterior e válida passa; formato inválido reprova", async () => {
    const { pendingNoAiLegal } = await import("@/lib/legal");
    const ok = (termsVersion: string) =>
      pendingNoAiLegal("desligada", {
        developerName: "Fulano de Tal",
        termsVersion,
      });
    expect(ok("2026-10-28")).toEqual([]);
    for (const bad of ["2026-11-31", "24/11/2026", "2026-1-5", ""])
      expect(ok(bad), bad).toEqual(["NO_AI_TERMS_VERSION"]);
  });

  it("vite.config: build de produção FALHA com pendência e passa sem ela", async () => {
    const { assertNoAiLegalReady } = await import("../../../build/legal-guard");
    expect(() =>
      assertNoAiLegalReady(["DEVELOPER_LEGAL_NAME", "NO_AI_TERMS_VERSION"]),
    ).toThrow(/Build de produção bloqueado[\s\S]*DEVELOPER_LEGAL_NAME/);
    expect(() => assertNoAiLegalReady([])).not.toThrow();
    // o vite.config chama a trava em TODO build que não é de desenvolvimento
    const cfg = readFileSync(resolve(ROOT, "vite.config.ts"), "utf8");
    expect(cfg).toMatch(
      /if \(command === "build" && mode !== "development"\) \{\s*assertNoAiLegalReady\(\);/,
    );
  });

  it("o estado do repositório nunca leva pendência a um build sem IA (falha o check na ativação incompleta)", async () => {
    const { pendingNoAiLegal } = await import("@/lib/legal");
    expect(pendingNoAiLegal()).toEqual([]);
  });

  it("verify-web-bundle reprova o marcador no cliente OU no SSR (mesmo marcador do legal.ts)", async () => {
    const { LEGAL_PENDING_MARK } = await import("@/lib/legal");
    const vb = (await import("../../../scripts/verify-web-bundle.mjs")) as {
      LEGAL_PENDING_MARK: string;
      verifyWebBundle: (o: {
        distDir: string;
        expectedUrl?: string;
        expectedKey?: string;
      }) => { ok: boolean; problems: string[]; facts: Record<string, number> };
    };
    expect(vb.LEGAL_PENDING_MARK).toBe(LEGAL_PENDING_MARK);
    const URL_OK = "https://abcdefghijklmnopqrst.supabase.co";
    const KEY_OK = "sb_publishable_abcdefghijklmnop";
    const mk = (client: string, server?: string) => {
      const dir = mkdtempSync(join(tmpdir(), "verbete-legal-"));
      mkdirSync(join(dir, "client"));
      writeFileSync(
        join(dir, "client", "a.js"),
        `${URL_OK} ${KEY_OK} ${client}`,
      );
      if (server !== undefined) {
        mkdirSync(join(dir, "server"));
        writeFileSync(join(dir, "server", "s.js"), server);
      }
      return vb.verifyWebBundle({
        distDir: dir,
        expectedUrl: URL_OK,
        expectedKey: KEY_OK,
      });
    };
    expect(mk("ok").ok).toBe(true);
    const c = mk(`"${LEGAL_PENDING_MARK}: confirmar com o dono>"`);
    expect(c.ok).toBe(false);
    expect(c.problems.join()).toMatch(/texto legal PENDENTE/);
    const s = mk("ok", `x="${LEGAL_PENDING_MARK}: data>"`);
    expect(s.ok).toBe(false);
    expect(s.facts.pendenteLegal).toBe(1);
  });
});
