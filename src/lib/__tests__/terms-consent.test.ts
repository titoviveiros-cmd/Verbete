import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, anon, fakeAuth, rpc } from "@/test/fake-auth";
import { identityKey } from "../terms-record";

vi.mock(
  "@/integrations/supabase/client",
  async () => (await import("@/test/fake-auth")).supabaseModule,
);

const ROOT = resolve(__dirname, "../../..");
const KEY = "verbete:terms-accepted";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
/** "Abrir o app": módulo novo (estado em memória zerado), mesmo aparelho. */
const fresh = async () => {
  vi.resetModules();
  return import("../terms-consent");
};
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
  fakeAuth.reset(null);
  rpc.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("aceite dos Termos — versão e persistência", () => {
  it("a versão é a data da 'Última atualização' de /terms (revisão → novo aceite)", async () => {
    const { TERMS_VERSION } = await fresh();
    const terms = readFileSync(resolve(ROOT, "src/routes/terms.tsx"), "utf8");
    const m = terms.match(
      /Última atualização: (\d{1,2}) de (\p{L}+) de (\d{4})/u,
    );
    const MESES = [
      "janeiro",
      "fevereiro",
      "março",
      "abril",
      "maio",
      "junho",
      "julho",
      "agosto",
      "setembro",
      "outubro",
      "novembro",
      "dezembro",
    ];
    expect(m, "data dos Termos não encontrada").not.toBeNull();
    const [, d, mes, y] = m!;
    const mm = String(MESES.indexOf(mes!.toLowerCase()) + 1).padStart(2, "0");
    expect(TERMS_VERSION).toBe(`${y}-${mm}-${d!.padStart(2, "0")}`);
  });

  it("aceitar grava versão e data DA IDENTIDADE — só um resumo do UID, sem token nem UID", async () => {
    fakeAuth.reset(anon(A));
    const { hasAcceptedTerms, acceptTerms, TERMS_VERSION } = await fresh();
    expect(hasAcceptedTerms()).toBe(false);
    acceptTerms();
    expect(hasAcceptedTerms()).toBe(true);
    const raw = localStorage.getItem(KEY)!;
    const entry = JSON.parse(raw).ids[identityKey(A)];
    expect(entry.version).toBe(TERMS_VERSION);
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
    expect(raw).not.toContain(A);
    expect(raw).not.toMatch(/token|password|senha|secret/i);
  });

  it("A: duas contas no mesmo aparelho — A aceita e sai; B entra SEM o aceite de A", async () => {
    fakeAuth.reset(account(A));
    const { hasAcceptedTerms, acceptTerms } = await fresh();
    acceptTerms();
    expect(hasAcceptedTerms()).toBe(true);
    fakeAuth.set(null); // logout de A
    expect(hasAcceptedTerms()).toBe(false);
    fakeAuth.set(account(B));
    expect(hasAcceptedTerms()).toBe(false);
  });

  it("B: B aceita e passa a criar conteúdo; A segue aceito (sem pedir de novo)", async () => {
    fakeAuth.reset(account(A));
    const t = await fresh();
    t.acceptTerms();
    fakeAuth.set(account(B));
    await expect(t.assertTermsAccepted()).rejects.toThrow(/aceite os Termos/);
    t.acceptTerms();
    await expect(t.assertTermsAccepted()).resolves.toBeUndefined();
    fakeAuth.set(account(A));
    expect(t.hasAcceptedTerms()).toBe(true);
  });

  it("C: logout seguido de sessão anônima NOVA não herda o aceite", async () => {
    fakeAuth.reset(anon(A));
    const { hasAcceptedTerms, acceptTerms } = await fresh();
    acceptTerms();
    fakeAuth.set(null);
    fakeAuth.set(anon(B)); // ensureAnonSession abre outra identidade
    expect(hasAcceptedTerms()).toBe(false);
  });

  it("D: mesmo UID e mesma versão — reabrir o app mantém o aceite", async () => {
    fakeAuth.reset(anon(A));
    (await fresh()).acceptTerms();
    const reaberto = await fresh();
    expect(reaberto.hasAcceptedTerms()).toBe(true);
    await expect(reaberto.assertTermsAccepted()).resolves.toBeUndefined();
  });

  it("E: aceite de versão ANTERIOR não vale — Termos revistos pedem novo aceite", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ids: {
          [identityKey(A)]: { version: "2020-01-01", at: "2020-01-01T00:00Z" },
        },
      }),
    );
    fakeAuth.reset(anon(A));
    expect((await fresh()).hasAcceptedTerms()).toBe(false);
  });

  it("F: registro antigo SEM identidade não vale para conta autenticada (e é descartado)", async () => {
    const { TERMS_VERSION } = await fresh();
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: TERMS_VERSION, at: "2026-10-26T00:00Z" }),
    );
    fakeAuth.reset(account(A));
    const t = await fresh();
    expect(t.hasAcceptedTerms()).toBe(false);
    await expect(t.assertTermsAccepted()).rejects.toThrow(/aceite os Termos/);
    expect(stored()).toEqual({ ids: {} });
    fakeAuth.set(null);
    fakeAuth.set(anon(B)); // nem a anônima que vem depois herda
    expect(t.hasAcceptedTerms()).toBe(false);
  });

  it("F: registro antigo vira o aceite da sessão ANÔNIMA em vigor — uma vez só", async () => {
    const { TERMS_VERSION } = await fresh();
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: TERMS_VERSION, at: "2026-10-26T00:00Z" }),
    );
    fakeAuth.reset(anon(A));
    const t = await fresh();
    expect(t.hasAcceptedTerms()).toBe(true);
    expect(stored().version).toBeUndefined(); // o formato antigo some
    expect(stored().ids[identityKey(A)].version).toBe(TERMS_VERSION);
    fakeAuth.set(null);
    fakeAuth.set(anon(B));
    expect(t.hasAcceptedTerms()).toBe(false);
  });

  it("registro corrompido ou forjado pela metade não vale", async () => {
    fakeAuth.reset(anon(A));
    for (const raw of [
      "{quebrado",
      JSON.stringify({ ok: true }),
      JSON.stringify("2026-05-18"),
      JSON.stringify({ ids: { [identityKey(A)]: { version: 20260518 } } }),
      JSON.stringify({ ids: { [A]: { version: "2026-05-18", at: "x" } } }),
    ]) {
      localStorage.setItem(KEY, raw);
      expect((await fresh()).hasAcceptedTerms(), raw).toBe(false);
    }
  });

  it("storage bloqueado (aba privada): aceite em memória, POR identidade", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    fakeAuth.reset(anon(A));
    const { hasAcceptedTerms, acceptTerms } = await fresh();
    expect(hasAcceptedTerms()).toBe(false);
    expect(() => acceptTerms()).not.toThrow();
    expect(hasAcceptedTerms()).toBe(true);
    fakeAuth.set(anon(B)); // mesma aba, outra identidade: não compartilha
    expect(hasAcceptedTerms()).toBe(false);
  });
});

describe("aceite dos Termos — nenhum caminho cria conteúdo sem ele", () => {
  it("a trava recusa sem aceite (e sem sessão) e libera depois", async () => {
    const t = await fresh();
    await expect(t.assertTermsAccepted()).rejects.toThrow(/sessão de jogo/);
    fakeAuth.set(anon(A));
    await expect(t.assertTermsAccepted()).rejects.toThrow(/aceite os Termos/);
    t.acceptTerms();
    await expect(t.assertTermsAccepted()).resolves.toBeUndefined();
  });

  it("G: troca de conta entre a tela e o clique — a gravação relê o UID e não passa", async () => {
    fakeAuth.reset(account(A));
    vi.resetModules();
    const t = await import("../terms-consent");
    const room = await import("../room");
    t.acceptTerms();
    expect(t.hasAcceptedTerms()).toBe(true); // a tela ainda é a de A
    fakeAuth.swapSilently(account(B)); // a sessão já é B (evento não chegou)
    await expect(
      room.submitDefinition("sala", 1, "p1", "um texto", "palavra"),
    ).rejects.toThrow(/aceite os Termos/);
    await expect(room.createRoom("p1", "Bia", "🦊", "#FF5C8A")).rejects.toThrow(
      /aceite os Termos/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a trava traz a tela para a sessão lida: sem aviso da outra aba, a caixa aparece para B", async () => {
    fakeAuth.reset(account(A));
    const t = await fresh();
    t.acceptTerms();
    fakeAuth.swapSilently(account(B)); // nenhum evento chegou
    expect(t.hasAcceptedTerms()).toBe(true); // a tela ainda mostra A…
    await expect(t.assertTermsAccepted()).rejects.toThrow(/aceite os Termos/);
    expect(t.hasAcceptedTerms()).toBe(false); // …e agora mostra B, sem aceite
    t.acceptTerms(); // B marca a caixa
    await expect(t.assertTermsAccepted()).resolves.toBeUndefined();
  });

  it("identidade ainda carregando: a trava espera a sessão e confere o aceite DELA", async () => {
    fakeAuth.reset(anon(A));
    (await fresh()).acceptTerms();
    fakeAuth.hold(); // boot com o token vencido: renovação em curso
    const t = await fresh();
    expect(t.hasAcceptedTerms()).toBe(false); // sem identidade, nada aceito
    await expect(t.assertTermsAccepted()).resolves.toBeUndefined();
    fakeAuth.swapSilently(anon(B));
    await expect(t.assertTermsAccepted()).rejects.toThrow(/aceite os Termos/);
  });

  it("caixa marcada antes de existir sessão: a gravação prende o aceite ao UID que usar", async () => {
    const t = await fresh(); // aparelho novo, sem sessão (sem rede no boot)
    t.acceptTerms();
    expect(t.hasAcceptedTerms()).toBe(false);
    fakeAuth.swapSilently(anon(A)); // ensureAnonSession da própria gravação
    await expect(t.assertTermsAccepted()).resolves.toBeUndefined();
    expect(stored().ids[identityKey(A)]).toBeTruthy();
    // e não sobra para mais ninguém
    fakeAuth.set(anon(A));
    fakeAuth.set(anon(B));
    await expect(t.assertTermsAccepted()).rejects.toThrow(/aceite os Termos/);
  });

  it("marcação pendente não passa de A para B", async () => {
    const t = await fresh();
    t.acceptTerms(); // sem sessão: pendente
    fakeAuth.set(anon(A));
    fakeAuth.set(account(B)); // trocou de identidade antes de gravar
    await expect(t.assertTermsAccepted()).rejects.toThrow(/aceite os Termos/);
  });

  it("marcação feita sem sessão não vira aceite da CONTA que entrar depois", async () => {
    const t = await fresh();
    t.acceptTerms(); // sem sessão (a gravação falhou sem rede): pendente
    fakeAuth.set(account(A)); // login por e-mail na mesma aba
    await expect(t.assertTermsAccepted()).rejects.toThrow(/aceite os Termos/);
    expect(t.hasAcceptedTerms()).toBe(false);
  });

  it("criar sala, entrar, entrar em sala pública, voltar e enviar definição recusam sem aceite", async () => {
    fakeAuth.reset(anon(A));
    vi.resetModules();
    const room = await import("../room");
    await expect(room.createRoom("p1", "Bia", "🦊", "#FF5C8A")).rejects.toThrow(
      /aceite os Termos/,
    );
    await expect(
      room.joinRoom("1234", "p1", "Bia", "🦊", "#FF5C8A"),
    ).rejects.toThrow(/aceite os Termos/);
    await expect(
      room.joinPublicRoom("p1", "Bia", "🦊", "#FF5C8A"),
    ).rejects.toThrow(/aceite os Termos/);
    await expect(
      room.submitDefinition("sala", 1, "p1", "um texto", "palavra"),
    ).rejects.toThrow(/aceite os Termos/);
    await expect(
      room.rejoinAfterKick("1234", "p1", "Bia", "🦊", "#FF5C8A"),
    ).rejects.toThrow(/aceite os Termos/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("com o aceite da identidade, criar sala chega à RPC", async () => {
    fakeAuth.reset(anon(A));
    vi.resetModules();
    const t = await import("../terms-consent");
    const room = await import("../room");
    t.acceptTerms();
    await expect(
      room.createRoom("p1", "Bia", "🦊", "#FF5C8A"),
    ).rejects.toMatchObject({ message: "rpc de teste" });
    expect(rpc).toHaveBeenCalledWith(
      "create_room_with_host",
      expect.anything(),
    );
  });

  it("todo ponto de entrada da interface tem a caixa e confere antes de enviar", () => {
    const pontos = [
      "src/routes/index.tsx", // Criar sala e Entrar com código (+ ?join=)
      "src/components/room/JoinFlow.tsx", // convite /room/CODE e App Links
      "src/routes/room.$code.tsx", // host sem registro e volta após remoção
      "src/components/room/phases/WriteDefinition.tsx", // definição
      "src/routes/login.tsx", // criar conta (nome no ranking)
      "src/routes/profile.tsx", // editar o nome (ranking)
      "src/routes/daily.tsx", // palpite do Diário (ranking do dia)
    ];
    for (const f of pontos) {
      const src = readFileSync(resolve(ROOT, f), "utf8");
      expect(src, f).toMatch(/useTermsGate\(/);
      expect(src, f).toMatch(/<TermsConsent\b/);
      expect(src, f).toMatch(/\.confirm\(/);
    }
    // gravações fora da lib de sala também releem a identidade da sessão
    for (const f of ["src/routes/profile.tsx", "src/routes/daily.tsx"])
      expect(readFileSync(resolve(ROOT, f), "utf8"), f).toMatch(
        /await assertTermsAccepted\(\)/,
      );
    // na lib, a trava vem DEPOIS da sessão garantida (é o UID dela que vale)
    const lib = readFileSync(resolve(ROOT, "src/lib/room.ts"), "utf8");
    expect(
      lib.match(
        /ensureAnonSession\(\)\)\) throw new Error\(SESSION_REQUIRED_MESSAGE\);\n(\s*\/\/[^\n]*\n)?\s*await assertTermsAccepted\(\);/g,
      ),
    ).toHaveLength(3);
    // entrar na sala confere de novo colado na gravação (sala e banimento demoram)
    expect(lib).toMatch(
      /await assertTermsAccepted\(\);\n\s*let effectiveId = playerId;\n\s*let \{ error: rpcErr \} = await callRejoin\(playerId\);/,
    );
    // a volta automática do host espera a identidade e o aceite dela
    const sala = readFileSync(
      resolve(ROOT, "src/routes/room.$code.tsx"),
      "utf8",
    );
    expect(sala).toMatch(
      /if \(termsAccepted === null\) return;\s*if \(!termsAccepted\) \{\s*setHostNeedsConsent\(true\);/,
    );
    // Google: login de conta existente não pede aceite; o cadastro sempre pede
    const login = readFileSync(resolve(ROOT, "src/routes/login.tsx"), "utf8");
    const google = login.slice(login.indexOf("const handleGoogle"));
    expect(google.slice(0, google.indexOf("};"))).not.toMatch(/confirm\(/);
    expect(login).toMatch(/useTermsGate\(\{ always: true \}\)/);
    expect(login).toMatch(/mode === "signup" && !terms\.confirm\(\)/);
  });
});
