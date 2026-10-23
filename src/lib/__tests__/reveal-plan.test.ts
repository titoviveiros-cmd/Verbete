import { describe, expect, it } from "vitest";
import {
  BEST_MS,
  BLUFFS_BUDGET_MS,
  BRIDGE_MS,
  CORRECT_MS,
  INTRO_MS,
  TRUTH_MS,
  bestBluffId,
  bluffDurations,
  bluffQuip,
  correctHeadline,
  orderBluffs,
  planReveal,
} from "../reveal-plan";

const votes: Record<string, number> = { a: 2, b: 0, c: 3, d: 2, e: 0 };
const defs = [
  { id: "a", letter: "C" },
  { id: "b", letter: "B" },
  { id: "c", letter: "A" },
  { id: "d", letter: "A" },
  { id: "e", letter: "D" },
];
const v = (id: string) => votes[id] ?? 0;

describe("ordem dos blefes", () => {
  it("menos votados primeiro, o que mais enganou por último", () => {
    expect(orderBluffs(defs, v).map((d) => d.id)).toEqual([
      "b",
      "e",
      "d",
      "a",
      "c",
    ]);
  });
  it("empate de votos: letra, depois id — sem aleatoriedade", () => {
    const tie = [
      { id: "z", letter: "B" },
      { id: "y", letter: "A" },
      { id: "x", letter: "A" },
    ];
    expect(orderBluffs(tie, () => 1).map((d) => d.id)).toEqual(["x", "y", "z"]);
    expect(orderBluffs([...tie].reverse(), () => 1).map((d) => d.id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });
});

describe("blefe da rodada (só reconhecimento)", () => {
  it("é o mais votado — o último revelado", () => {
    const ordered = orderBluffs(defs, v);
    expect(bestBluffId(ordered, v)).toBe("c");
  });
  it("empate no topo: o que fecha a sequência (determinístico)", () => {
    const tie = [
      { id: "p", letter: "A" },
      { id: "q", letter: "B" },
    ];
    const ordered = orderBluffs(tie, () => 2);
    expect(bestBluffId(ordered, () => 2)).toBe("q");
  });
  it("todos com zero votos: não existe blefe da rodada", () => {
    const ordered = orderBluffs(defs, () => 0);
    expect(bestBluffId(ordered, () => 0)).toBeNull();
  });
  it("sem blefes: nada", () => {
    expect(bestBluffId([], () => 0)).toBeNull();
  });
});

describe("ritmo", () => {
  it("verdade quase imediata; acertadores logo depois", () => {
    const { steps } = planReveal([0, 1], true);
    expect(steps.map((s) => s.kind)).toEqual([
      "intro",
      "truth",
      "correct",
      "bridge",
      "bluff",
      "bluff",
      "best",
      "hold",
    ]);
    expect(steps.find((s) => s.kind === "truth")!.at).toBe(INTRO_MS);
    expect(INTRO_MS).toBeGreaterThanOrEqual(400);
    expect(INTRO_MS).toBeLessThanOrEqual(700);
    expect(steps.find((s) => s.kind === "correct")!.at).toBe(
      INTRO_MS + TRUTH_MS,
    );
  });
  it("verdade sempre antes de qualquer blefe", () => {
    const { steps } = planReveal([3, 0, 2], true);
    const truth = steps.find((s) => s.kind === "truth")!.at;
    for (const s of steps.filter((x) => x.kind === "bluff"))
      expect(s.at).toBeGreaterThan(truth);
  });
  it("blefe sem voto passa mais rápido que blefe que enganou", () => {
    const [zero, one, many] = bluffDurations([0, 1, 4]);
    expect(zero).toBeLessThan(one!);
    expect(one).toBeLessThanOrEqual(many!);
  });
  it("sala cheia (11 blefes) acelera e não passa do orçamento", () => {
    const d = bluffDurations([0, 0, 0, 1, 1, 1, 2, 2, 3, 4, 6]);
    const sum = d.reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(BLUFFS_BUDGET_MS + 200);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(300);
    const { holdAt } = planReveal([0, 0, 0, 1, 1, 1, 2, 2, 3, 4, 6], true);
    expect(holdAt).toBeLessThanOrEqual(
      INTRO_MS +
        TRUTH_MS +
        CORRECT_MS +
        BRIDGE_MS +
        BLUFFS_BUDGET_MS +
        200 +
        BEST_MS,
    );
    expect(holdAt).toBeLessThan(15_000);
  });
  it("sala mínima (1 blefe) e rodada sem blefes", () => {
    expect(planReveal([1], true).holdAt).toBeLessThan(6_000);
    const none = planReveal([], false);
    expect(none.steps.map((s) => s.kind)).toEqual([
      "intro",
      "truth",
      "correct",
      "hold",
    ]);
  });
  it("sem blefe da rodada não há passo de destaque", () => {
    expect(planReveal([0, 0], false).steps.some((s) => s.kind === "best")).toBe(
      false,
    );
  });
});

describe("microcopy", () => {
  it("varia por situação e é igual para todos (mesmos dados → mesma frase)", () => {
    expect(bluffQuip(0, 3, 2, "A")).toBe(bluffQuip(0, 3, 2, "A"));
    expect(["ninguém caiu nessa", "passou batido", "não colou"]).toContain(
      bluffQuip(0, 3, 2, "A"),
    );
    expect(["pegou um", "fez uma vítima", "um caiu direitinho"]).toContain(
      bluffQuip(1, 3, 5, "B"),
    );
    expect(["enganou todo mundo!", "golpe perfeito"]).toContain(
      bluffQuip(3, 3, 1, "C"),
    );
    expect(["quase perfeito", "por um triz, todos"]).toContain(
      bluffQuip(3, 4, 1, "C"),
    );
  });
  it("não repete sempre a mesma frase entre rodadas", () => {
    const seen = new Set(
      [1, 2, 3, 4, 5, 6].map((r) => bluffQuip(0, 4, r, "A")),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
  it("título de quem acertou", () => {
    expect(correctHeadline(0, 4, false)).toMatch(/Ninguém acertou/);
    expect(correctHeadline(4, 4, true)).toMatch(/Todo mundo/);
    expect(correctHeadline(2, 4, true)).toMatch(/Você acertou/);
    expect(correctHeadline(1, 4, false)).toMatch(/Só um/);
    expect(correctHeadline(2, 4, false)).toMatch(/Acertaram/);
  });
});
