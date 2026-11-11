// Reaceite ÚNICO dos Termos (11/11/2026): data exibida × versão de
// consentimento. Só revisão MATERIAL pede novo aceite; o pacote do modo sem IA
// (#63: sem IA + nome legal) e o fluxo de denúncia/recurso (#65, /denuncias)
// entram juntos em UMA revisão material. Vale igual para convidado (sessão
// anônima) e para conta.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, anon, fakeAuth } from "@/test/fake-auth";
import { identityKey } from "../terms-record";

vi.mock(
  "@/integrations/supabase/client",
  async () => (await import("@/test/fake-auth")).supabaseModule,
);

const EXTERNAL_AI = "../../../supabase/functions/_shared/external-ai.ts";
const ROOT = resolve(__dirname, "../../..");
const KEY = "verbete:terms-accepted";
const G = "00000000-0000-4000-8000-0000000000c1"; // convidado
const C = "00000000-0000-4000-8000-0000000000c2"; // conta
const PERFIS = [
  ["convidado", () => anon(G), G],
  ["conta", () => account(C), C],
] as const;

async function modo(mode: "ligada" | "desligada") {
  vi.resetModules();
  vi.doMock(EXTERNAL_AI, () => ({
    EXTERNAL_AI_MODE: mode,
    isExternalAiOff: (m: string = mode) => m === "desligada",
  }));
  const legal = await import("../legal");
  const consent = await import("../terms-consent");
  return { legal, consent };
}
const aceitoEm = (uid: string, version: string) =>
  localStorage.setItem(
    KEY,
    JSON.stringify({
      ids: { [identityKey(uid)]: { version, at: "2026-10-28T00:00:00Z" } },
    }),
  );

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.doUnmock(EXTERNAL_AI);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("data exibida × versão de consentimento (puro)", () => {
  it("display = última revisão; consentimento = última revisão MATERIAL", async () => {
    const { legal } = await modo("ligada");
    const base = legal.AI_TERMS_CHANGES;
    expect(legal.termsVersionsOf(base)).toEqual({
      display: "2026-10-27",
      consent: "2026-10-27",
    });
    // ajuste de redação depois: só a data exibida muda
    const redacao = [
      ...base,
      { date: "2027-01-10", material: false, resumo: "redação" },
    ];
    expect(legal.termsVersionsOf(redacao)).toEqual({
      display: "2027-01-10",
      consent: "2026-10-27",
    });
    // revisão material depois: consentimento acompanha
    const material = [
      ...redacao,
      { date: "2027-02-01", material: true, resumo: "novo tratamento" },
    ];
    expect(legal.termsVersionsOf(material).consent).toBe("2027-02-01");
    expect(() => legal.termsVersionsOf([])).toThrow();
    expect(() =>
      legal.termsVersionsOf([
        { date: "2026-01-01", material: false, resumo: "x" },
      ]),
    ).toThrow();
  });

  it("histórico publicado em ordem, com datas válidas, e consentimento ≤ data exibida", async () => {
    const { legal } = await modo("ligada");
    const datas = legal.AI_TERMS_CHANGES.map((c) => c.date);
    expect([...datas].sort()).toEqual(datas);
    for (const d of datas) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(legal.TERMS_CONSENT_VERSION <= legal.TERMS_DISPLAY_DATE).toBe(true);
    // no modo sem IA a data nova é validada pela trava (pendingNoAiLegal:
    // válida e POSTERIOR a 2026-10-27) — o marcador pendente reprova o build
  });

  it("IA ligada: NADA muda — 2026-10-27 exibida e aceita", async () => {
    const { legal, consent } = await modo("ligada");
    expect(legal.TERMS_CHANGES).toBe(legal.AI_TERMS_CHANGES);
    expect(legal.TERMS_DISPLAY_DATE).toBe("2026-10-27");
    expect(consent.TERMS_VERSION).toBe("2026-10-27");
  });

  it("modo sem IA: UMA revisão material nova, que junta sem IA + nome legal + denúncia/recurso", async () => {
    const { legal, consent } = await modo("desligada");
    const novas = legal.TERMS_CHANGES.slice(legal.AI_TERMS_CHANGES.length);
    expect(novas).toHaveLength(1);
    expect(novas[0]).toBe(legal.NO_AI_TERMS_CHANGE);
    expect(novas[0]!.material).toBe(true);
    expect(novas[0]!.resumo).toMatch(/sem IA/);
    expect(novas[0]!.resumo).toMatch(/nome legal/);
    expect(novas[0]!.resumo).toMatch(/\/denuncias/);
    expect(consent.TERMS_VERSION).toBe(legal.NO_AI_TERMS_VERSION);
    expect(legal.TERMS_DISPLAY_DATE).toBe(legal.NO_AI_TERMS_VERSION);
  });
});

describe.each(PERFIS)("reaceite único — %s", (_nome, sessao, uid) => {
  it("IA ligada: quem aceitou 2026-10-27 segue aceito", async () => {
    aceitoEm(uid, "2026-10-27");
    fakeAuth.reset(sessao());
    const { consent } = await modo("ligada");
    expect(consent.hasAcceptedTerms()).toBe(true);
  });

  it("modo sem IA: pede o aceite UMA vez; depois de aceitar, reabrir o app não pede de novo", async () => {
    aceitoEm(uid, "2026-10-27");
    fakeAuth.reset(sessao());
    const a = await modo("desligada");
    expect(a.consent.hasAcceptedTerms()).toBe(false);
    await expect(a.consent.assertTermsAccepted()).rejects.toThrow(
      /aceite os Termos/,
    );
    a.consent.acceptTerms();
    expect(a.consent.hasAcceptedTerms()).toBe(true);
    const reaberto = await modo("desligada");
    expect(reaberto.consent.hasAcceptedTerms()).toBe(true);
    const entry = JSON.parse(localStorage.getItem(KEY)!).ids[identityKey(uid)];
    expect(entry.version).toBe(reaberto.legal.NO_AI_TERMS_VERSION);
  });

  it("depois do reaceite, um ajuste NÃO material não pede outro aceite", async () => {
    fakeAuth.reset(sessao());
    const { legal, consent } = await modo("desligada");
    consent.acceptTerms();
    const depois = legal.termsVersionsOf([
      ...legal.TERMS_CHANGES,
      { date: "2099-01-01", material: false, resumo: "redação" },
    ]);
    const entry = JSON.parse(localStorage.getItem(KEY)!).ids[identityKey(uid)];
    expect(depois.consent).toBe(entry.version); // continua aceito
    expect(depois.display).toBe("2099-01-01");
  });
});

describe("/terms no modo sem IA: texto do pacote único", () => {
  it("§4 aponta /denuncias (retorno, aviso ao autor, recurso, anonimato do denunciante); §1/§9 explicam o que é relevante", () => {
    const src = readFileSync(resolve(ROOT, "src/routes/terms.tsx"), "utf8");
    expect(src).toMatch(/href="\/denuncias"/);
    expect(src).toMatch(/pode contestar a decisão por lá/);
    expect(src).toMatch(/nunca sabe quem\s+denunciou/);
    expect(src).toMatch(/ajustes de redação só mudam a data/);
    expect(src).toMatch(/formatLegalDate\(TERMS_DISPLAY_DATE\)/);
  });

  it("o build sem IA exige a página /denuncias (senão seriam dois aceites)", async () => {
    const guard = await import("../../../build/legal-guard");
    expect(guard.pendingReaceiteUnico(false, () => false)).toEqual([]);
    expect(guard.pendingReaceiteUnico(true, () => false)).toEqual([
      "DENUNCIAS_PAGE",
    ]);
    expect(guard.pendingReaceiteUnico(true, () => true)).toEqual([]);
    expect(() => guard.assertNoAiLegalReady(["DENUNCIAS_PAGE"])).toThrow(
      /denuncias\.tsx ausente[\s\S]*\/denuncias/,
    );
    expect(() => guard.assertNoAiLegalReady([])).not.toThrow();
  });
});
