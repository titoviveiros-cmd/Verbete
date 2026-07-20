import { describe, it, expect, beforeEach } from "vitest";
import {
  getPlayerId,
  regeneratePlayerId,
  setPlayerId,
  getStored,
  setStored,
} from "@/lib/player-id";

beforeEach(() => localStorage.clear());

describe("getPlayerId", () => {
  it("gera id com prefixo p_ e persiste entre chamadas", () => {
    const id = getPlayerId();
    expect(id).toMatch(/^p_[a-z0-9]+$/);
    expect(getPlayerId()).toBe(id);
  });
});

describe("regeneratePlayerId", () => {
  it("troca o id persistido (recuperação de player_id_taken)", () => {
    const antigo = getPlayerId();
    const novo = regeneratePlayerId();
    expect(novo).not.toBe(antigo);
    expect(getPlayerId()).toBe(novo);
  });
});

describe("setPlayerId", () => {
  it("força um id específico (restauração de host)", () => {
    setPlayerId("p_host_restaurado");
    expect(getPlayerId()).toBe("p_host_restaurado");
  });
});

describe("getStored/setStored", () => {
  it("roundtrip JSON com prefixo verbete:", () => {
    setStored("nick", "Tito");
    expect(getStored("nick", "")).toBe("Tito");
    expect(localStorage.getItem("verbete:nick")).toBe('"Tito"');
  });
  it("fallback quando não existe ou está corrompido", () => {
    expect(getStored("nada", "padrão")).toBe("padrão");
    localStorage.setItem("verbete:ruim", "{json quebrado");
    expect(getStored("ruim", 42)).toBe(42);
  });
});
