import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const KEY = "verbete:terms-accepted";
const fresh = async () => {
  vi.resetModules();
  return import("../terms-consent");
};

beforeEach(() => localStorage.clear());
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

  it("aparelho novo não aceitou; aceitar grava a versão e a data", async () => {
    const { hasAcceptedTerms, acceptTerms, TERMS_VERSION } = await fresh();
    expect(hasAcceptedTerms()).toBe(false);
    acceptTerms();
    expect(hasAcceptedTerms()).toBe(true);
    const rec = JSON.parse(localStorage.getItem(KEY)!);
    expect(rec.version).toBe(TERMS_VERSION);
    expect(Number.isNaN(Date.parse(rec.at))).toBe(false);
  });

  it("persiste: outro carregamento do app no mesmo aparelho já encontra o aceite", async () => {
    (await fresh()).acceptTerms();
    const reaberto = await fresh();
    expect(reaberto.hasAcceptedTerms()).toBe(true);
  });

  it("aceite de versão ANTERIOR não vale: Termos revistos pedem novo aceite", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: "2020-01-01", at: "2020-01-01T00:00:00Z" }),
    );
    const { hasAcceptedTerms } = await fresh();
    expect(hasAcceptedTerms()).toBe(false);
  });

  it("registro corrompido ou forjado sem versão não vale", async () => {
    localStorage.setItem(KEY, "{quebrado");
    expect((await fresh()).hasAcceptedTerms()).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ ok: true }));
    expect((await fresh()).hasAcceptedTerms()).toBe(false);
    localStorage.setItem(KEY, JSON.stringify("2026-05-18"));
    expect((await fresh()).hasAcceptedTerms()).toBe(false);
  });

  it("storage bloqueado (aba privada): o aceite vale na sessão, sem quebrar", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { hasAcceptedTerms, acceptTerms } = await fresh();
    expect(hasAcceptedTerms()).toBe(false);
    expect(() => acceptTerms()).not.toThrow();
    expect(hasAcceptedTerms()).toBe(true);
  });
});

describe("aceite dos Termos — nenhum caminho cria conteúdo sem ele", () => {
  it("assertTermsAccepted recusa sem aceite e libera depois", async () => {
    const { assertTermsAccepted, acceptTerms } = await fresh();
    expect(() => assertTermsAccepted()).toThrow(/aceite os Termos/);
    acceptTerms();
    expect(() => assertTermsAccepted()).not.toThrow();
  });

  it("criar sala, entrar, entrar em sala pública e enviar definição recusam sem aceite", async () => {
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
  });

  it("todo ponto de entrada da interface tem a caixa e confere antes de enviar", () => {
    const pontos = [
      "src/routes/index.tsx", // Criar sala e Entrar com código (+ ?join=)
      "src/components/room/JoinFlow.tsx", // convite /room/CODE e App Links
      "src/routes/room.$code.tsx", // host sem registro e volta após remoção
      "src/components/room/phases/WriteDefinition.tsx", // definição
      "src/routes/login.tsx", // criar conta e Google (nome no ranking)
      "src/routes/profile.tsx", // editar o nome (ranking)
    ];
    for (const f of pontos) {
      const src = readFileSync(resolve(ROOT, f), "utf8");
      expect(src, f).toMatch(/useTermsGate\(\)/);
      expect(src, f).toMatch(/<TermsConsent\b/);
      expect(src, f).toMatch(/\.confirm\(\)/);
    }
    // a volta automática do host só acontece com o aceite já registrado
    const sala = readFileSync(
      resolve(ROOT, "src/routes/room.$code.tsx"),
      "utf8",
    );
    expect(sala).toMatch(
      /if \(!hasAcceptedTerms\(\)\) \{\s*setHostNeedsConsent\(true\);/,
    );
  });
});
