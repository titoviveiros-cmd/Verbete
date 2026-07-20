import { describe, it, expect } from "vitest";
import {
  computeTeamScores,
  isTruthDef,
  type Player,
  type Team,
} from "@/lib/room";

const player = (id: string, score: number, team_id: string | null): Player =>
  ({
    id,
    score,
    team_id,
    nickname: id,
    avatar: "🦊",
    color: "#fff",
  }) as unknown as Player;

describe("computeTeamScores", () => {
  const teams: Team[] = [
    { id: "t1", name: "Vermelho", color: "#f00", emoji: "🔥" },
    { id: "t2", name: "Azul", color: "#00f", emoji: "🌊" },
  ];
  it("soma o score dos membros por equipe", () => {
    const players = [
      player("a", 3, "t1"),
      player("b", 4, "t1"),
      player("c", 5, "t2"),
    ];
    const out = computeTeamScores(players, teams);
    expect(out.find((t) => t.id === "t1")?.score).toBe(7);
    expect(out.find((t) => t.id === "t2")?.score).toBe(5);
  });
  it("equipe sem membros soma 0 e jogador sem time não conta", () => {
    const out = computeTeamScores([player("solto", 9, null)], teams);
    expect(out.every((t) => t.score === 0)).toBe(true);
  });
});

describe("isTruthDef", () => {
  it("reconhece a sentinela __truth__", () => {
    expect(isTruthDef({ player_id: "__truth__" })).toBe(true);
    expect(isTruthDef({ player_id: "p_abc" })).toBe(false);
  });
});
