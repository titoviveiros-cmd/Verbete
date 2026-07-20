import { describe, it, expect } from "vitest";
import {
  BOT_NAMES,
  BOT_FAKE_DEFINITIONS_TEMPLATES,
  randomBotDef,
} from "@/lib/bot-names";
import { AVATARS, COLORS, randomAvatar, randomColor } from "@/lib/avatars";

describe("banco de bots", () => {
  it("pool de blefes grande (playtest: 14 repetia rápido) e sem duplicatas", () => {
    expect(BOT_FAKE_DEFINITIONS_TEMPLATES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(BOT_FAKE_DEFINITIONS_TEMPLATES).size).toBe(
      BOT_FAKE_DEFINITIONS_TEMPLATES.length,
    );
    expect(new Set(BOT_NAMES).size).toBe(BOT_NAMES.length);
  });
  it("randomBotDef é determinístico pelo seed e cobre o pool", () => {
    expect(randomBotDef(3)).toBe(BOT_FAKE_DEFINITIONS_TEMPLATES[3]);
    expect(randomBotDef(BOT_FAKE_DEFINITIONS_TEMPLATES.length + 3)).toBe(
      BOT_FAKE_DEFINITIONS_TEMPLATES[3],
    );
  });
});

describe("avatares", () => {
  it("randomAvatar/randomColor sorteiam dentro dos conjuntos", () => {
    for (let i = 0; i < 20; i++) {
      expect(AVATARS).toContain(randomAvatar());
      expect(COLORS).toContain(randomColor());
    }
  });
});
