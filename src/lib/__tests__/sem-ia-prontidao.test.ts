// Trava dos 168 (11/11/2026): a IA não é suspensa de forma planejada (nem o
// Diário vai para 'escolha') sem ≥ 168 conjuntos aprovados jogáveis — falha
// FECHADA. O caminho real contra o banco está em scripts/test-rollback.mjs (CI).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  avaliarProntidaoSemIa,
  checarProntidaoSemIa,
  META_APROVADOS_JOGAVEIS,
  SQL_PRONTIDAO_SEM_IA,
  travaAppConfig,
} from "../../../scripts/lib/sem-ia-prontidao.mjs";

const banco = (row: Record<string, unknown> | null) =>
  vi.fn(async () => ({ rows: row ? [row] : [] }));
const quebrado = () =>
  vi.fn(async () => {
    throw Object.assign(new Error("x"), { code: "ECONNREFUSED" });
  });

describe("prontidão do modo sem IA (pura)", () => {
  it("meta = 168", () => expect(META_APROVADOS_JOGAVEIS).toBe(168));

  it("167 aprovados jogáveis + escolha = NÃO pronto", () => {
    const r = avaliarProntidaoSemIa({
      daily_mode: "escolha",
      aprovado_jogavel: 167,
    });
    expect(r.ok).toBe(false);
    expect(r.motivos.join()).toMatch(/167 \(< 168\)/);
  });

  it("168 + escolha = pronto (borda inclusiva)", () => {
    expect(
      avaliarProntidaoSemIa({ daily_mode: "escolha", aprovado_jogavel: 168 })
        .ok,
    ).toBe(true);
  });

  it("estoque cheio mas Diário em 'juiz' (ou ausente = juiz) = NÃO pronto", () => {
    expect(
      avaliarProntidaoSemIa({ daily_mode: "juiz", aprovado_jogavel: 500 }).ok,
    ).toBe(false);
    expect(
      avaliarProntidaoSemIa({ daily_mode: null, aprovado_jogavel: 500 }).ok,
    ).toBe(false);
    expect(
      avaliarProntidaoSemIa({ daily_mode: "pausa", aprovado_jogavel: 500 }).ok,
    ).toBe(false);
  });

  it("contagem ilegível = NÃO pronto (falha fechada)", () => {
    for (const n of [undefined, null, "abc", -1, 1.5])
      expect(
        avaliarProntidaoSemIa({ daily_mode: "escolha", aprovado_jogavel: n })
          .ok,
      ).toBe(false);
  });

  it("a consulta usa o MESMO critério de 'aprovado jogável' do painel e do sorteio", () => {
    const sql = SQL_PRONTIDAO_SEM_IA.replace(/\s+/g, " ");
    expect(sql).toMatch(/s\.status = 'aprovado'/);
    expect(sql).toMatch(/w\.status = 'published'/);
    expect(sql).toMatch(/w\.meaning = s\.truth_snapshot/);
    const d1 = readFileSync(
      "supabase/migrations/20261108120000_diario_d1_escolha.sql",
      "utf8",
    );
    expect(d1).toMatch(
      /'aprovado_jogavel', \(SELECT count\(\*\) FROM public\.daily_choice_sets s JOIN public\.words w ON w\.id = s\.word_id\s+WHERE s\.status = 'aprovado' AND w\.status = 'published' AND w\.meaning = s\.truth_snapshot\)/,
    );
  });
});

describe("checarProntidaoSemIa (com o banco)", () => {
  it("erro do banco = NÃO pronto", async () => {
    const r = await checarProntidaoSemIa(quebrado());
    expect(r.ok).toBe(false);
    expect(r.motivos[0]).toMatch(/ECONNREFUSED/);
  });
  it("consulta sem linha = NÃO pronto", async () => {
    expect((await checarProntidaoSemIa(banco(null))).ok).toBe(false);
  });
});

describe("travaAppConfig (set-app-config.mjs)", () => {
  it("ai_mode=suspenso com 0 aprovados (produção hoje) = RECUSADO", async () => {
    const q = banco({ daily_mode: "juiz", aprovado_jogavel: 0 });
    const r = await travaAppConfig({
      key: "ai_mode",
      value: "suspenso",
      query: q,
    });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/aprovados jogáveis = 0/);
    expect(r.erro).toMatch(/daily_mode = 'juiz'/);
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("ai_mode=suspenso com 168 + escolha = liberado", async () => {
    const r = await travaAppConfig({
      key: "ai_mode",
      value: " Suspenso ",
      query: banco({ daily_mode: "escolha", aprovado_jogavel: 168 }),
    });
    expect(r.ok).toBe(true);
  });

  it("ai_mode=suspenso com o banco fora = RECUSADO (falha fechada)", async () => {
    const r = await travaAppConfig({
      key: "ai_mode",
      value: "suspenso",
      query: quebrado(),
    });
    expect(r.ok).toBe(false);
  });

  it("--emergencia libera a contenção SEM consultar e avisa da pausa do Diário", async () => {
    const q = quebrado();
    const r = await travaAppConfig({
      key: "ai_mode",
      value: "suspenso",
      emergencia: true,
      query: q,
    });
    expect(r.ok).toBe(true);
    expect(r.aviso).toMatch(/EMERGÊNCIA/);
    expect(q).not.toHaveBeenCalled();
  });

  it("daily_mode=escolha exige só o estoque (o modo é o que está mudando)", async () => {
    expect(
      (
        await travaAppConfig({
          key: "daily_mode",
          value: "escolha",
          query: banco({ daily_mode: "juiz", aprovado_jogavel: 168 }),
        })
      ).ok,
    ).toBe(true);
    const r = await travaAppConfig({
      key: "daily_mode",
      value: "escolha",
      query: banco({ daily_mode: "juiz", aprovado_jogavel: 40 }),
    });
    expect(r.ok).toBe(false);
    expect(r.erro).not.toMatch(/daily_mode = /);
    expect(
      (
        await travaAppConfig({
          key: "daily_mode",
          value: "escolha",
          query: quebrado(),
        })
      ).ok,
    ).toBe(false);
  });

  it("rollbacks e outras chaves nunca consultam nem são barrados", async () => {
    const q = quebrado();
    for (const [key, value] of <Array<[string, string]>>[
      ["ai_mode", "ligado"],
      ["daily_mode", "juiz"],
      ["daily_mode", "pausa"],
      ["client.maintenance", "on"],
    ])
      expect((await travaAppConfig({ key, value, query: q })).ok).toBe(true);
    expect(q).not.toHaveBeenCalled();
  });

  it("set-app-config.mjs passa pela trava ANTES de qualquer escrita", () => {
    const src = readFileSync("scripts/set-app-config.mjs", "utf8");
    expect(src).toMatch(
      /import \{ travaAppConfig \} from "\.\/lib\/sem-ia-prontidao\.mjs"/,
    );
    const trava = src.indexOf("if (!(await travaOk()))");
    const escrita = src.indexOf("INSERT INTO public.app_config");
    const del = src.indexOf("DELETE FROM public.app_config");
    expect(trava).toBeGreaterThan(0);
    // a escrita só existe dentro de gravar(), chamada no else da trava
    expect(src.indexOf("await gravar()")).toBeGreaterThan(trava);
    expect(escrita).toBeGreaterThan(src.indexOf("async function gravar()"));
    expect(del).toBeGreaterThan(src.indexOf("async function gravar()"));
    expect(src).toMatch(/process\.exitCode = 3/);
  });
});
