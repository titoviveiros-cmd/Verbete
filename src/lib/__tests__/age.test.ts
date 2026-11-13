import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGE_SELF_DECLARATION_NOTICE,
  ageBandFromBirthYear,
  botsOnly,
  declaredAgeBand,
  mostProtective,
  readAgeDeclaration,
  saveAgeDeclaration,
} from "@/lib/age";
import { ageDeclarationStorageEntry } from "@/lib/age-record";
import {
  AGE_SIGNALS_ENABLED,
  ageBandFromSignal,
  getPlayAgeSignal,
  registerAgeSignalRequester,
} from "@/lib/age-signals";

// ECA Digital B5 (11/11/2026): selo 13+, ano de nascimento SÓ no aparelho,
// menor de 13 só com bots, sinal da Play preparado e DESLIGADO.
// Autodeclaração NÃO é comprovação jurídica de idade.
const NOW = new Date("2026-11-11T12:00:00Z");

afterEach(() => {
  localStorage.clear();
  registerAgeSignalRequester(null);
});

describe("faixa pelo ano de nascimento (idade mínima possível = mais protetivo)", () => {
  it("quem pode ter 12 ainda é menor de 13", () => {
    expect(ageBandFromBirthYear(2013, NOW)).toBe("under13"); // 12 ou 13
    expect(ageBandFromBirthYear(2012, NOW)).toBe("teen"); // 13 ou 14
  });
  it("quem pode ter 17 ainda é adolescente", () => {
    expect(ageBandFromBirthYear(2008, NOW)).toBe("teen"); // 17 ou 18
    expect(ageBandFromBirthYear(2007, NOW)).toBe("adult");
  });
  it("ano impossível = desconhecido", () => {
    expect(ageBandFromBirthYear(2030, NOW)).toBe("unknown");
    expect(ageBandFromBirthYear(1800, NOW)).toBe("unknown");
    expect(ageBandFromBirthYear(2000.5, NOW)).toBe("unknown");
  });
  it("só menor de 13 fica no modo só bots", () => {
    expect(botsOnly("under13")).toBe(true);
    for (const b of ["teen", "adult", "unknown"] as const)
      expect(botsOnly(b)).toBe(false);
  });
});

describe("guardado só no aparelho", () => {
  it("salva e lê o ano; nada além disso", () => {
    expect(readAgeDeclaration()).toBeNull();
    expect(declaredAgeBand(NOW)).toBe("unknown");
    saveAgeDeclaration(2010, NOW);
    expect(readAgeDeclaration()).toEqual({
      birthYear: 2010,
      at: NOW.toISOString(),
    });
    expect(declaredAgeBand(NOW)).toBe("teen");
    expect(Object.keys(localStorage)).toEqual(["verbete:age-declaration"]);
  });
  it("entrada usada pelos E2E tem o mesmo formato", () => {
    const e = ageDeclarationStorageEntry(1990);
    localStorage.setItem(e.name, e.value);
    expect(readAgeDeclaration()?.birthYear).toBe(1990);
  });
  it("o módulo não chama o servidor", () => {
    const src = readFileSync("src/lib/age.ts", "utf8");
    expect(src).not.toMatch(/supabase|fetch\(|rpc\(/);
  });
  it("o texto diz que autodeclaração não comprova idade", () => {
    expect(AGE_SELF_DECLARATION_NOTICE).toMatch(/não comprova/);
    expect(AGE_SELF_DECLARATION_NOTICE).toMatch(/só neste aparelho/);
  });
});

describe("mais protetivo entre declaração e sinal da loja", () => {
  it("vence a faixa mais protetiva", () => {
    expect(mostProtective("adult", "teen")).toBe("teen");
    expect(mostProtective("teen", "under13")).toBe("under13");
    expect(mostProtective("adult", null)).toBe("adult");
    expect(mostProtective(null, null)).toBe("unknown");
  });
});

describe("Play Age Signals: preparado e DESLIGADO", () => {
  it("desligado por padrão: não chama nada", async () => {
    let called = false;
    registerAgeSignalRequester(async () => {
      called = true;
      return { ageLower: 13, ageUpper: 15, source: "declared" };
    });
    expect(AGE_SIGNALS_ENABLED).toBe(false);
    expect(await getPlayAgeSignal()).toBeNull();
    expect(called).toBe(false);
  });
  it("ligado: usa o limite inferior da faixa; erro vira null", async () => {
    registerAgeSignalRequester(async () => ({
      ageLower: 13,
      ageUpper: 15,
      source: "declared",
    }));
    const s = await getPlayAgeSignal(true);
    expect(ageBandFromSignal(s)).toBe("teen");
    expect(
      ageBandFromSignal({ ageLower: 0, ageUpper: 12, source: "supervised" }),
    ).toBe("under13");
    expect(ageBandFromSignal(null)).toBeNull();
    registerAgeSignalRequester(async () => {
      throw new Error("sem plugin");
    });
    expect(await getPlayAgeSignal(true)).toBeNull();
  });
});
