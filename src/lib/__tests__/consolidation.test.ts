import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { friendlyEntryError } from "@/lib/entry-errors";
import {
  BOT_COORDINATOR_HOLD_MS,
  BOT_PICK_GUEST_EXTRA_MS,
  botPickDelayMs,
} from "@/lib/game-times";
import { THEME_BOOT_SCRIPT } from "@/lib/theme-boot";
import { PHASE_ANNOUNCER_TOTAL_MS } from "@/components/room/PhaseAnnouncer";

// Consolidação do playtest (2026-10-21): identidade, tema claro, 4–12 e
// coordenador bot. (Pausa e identidade no banco: scripts/test-pause-resume.mjs
// e scripts/test-player-id.mjs; tempo real do bot: e2e/visual/bot-coordinator.)
const root = join(__dirname, "../../..");

describe("erros de entrada nunca mostram o banco", () => {
  it("chave duplicada / constraint vira texto nosso", () => {
    const raw = new Error(
      'duplicate key value violates unique constraint "players_pkey"',
    );
    const msg = friendlyEntryError(raw, "join");
    expect(msg).toBe("Não deu para entrar na sala agora. Tente de novo.");
    expect(msg).not.toMatch(/duplicate|constraint|players_pkey/);
    expect(friendlyEntryError({ message: "player_id_taken" }, "create")).toBe(
      "Não deu para criar a sala agora. Tente de novo.",
    );
  });
  it("motivos conhecidos ganham texto próprio", () => {
    expect(friendlyEntryError(new Error("room_not_found"), "join")).toBe(
      "Sala não encontrada. Confira o código.",
    );
    expect(friendlyEntryError(new Error("Sala não encontrada"), "join")).toBe(
      "Sala não encontrada. Confira o código.",
    );
    expect(friendlyEntryError({ message: "player_banned" }, "join")).toMatch(
      /banido/,
    );
    expect(friendlyEntryError(new TypeError("Failed to fetch"), "join")).toBe(
      "Sem conexão. Confira a internet e tente de novo.",
    );
    expect(friendlyEntryError("qualquer coisa", "join")).toBe(
      "Não deu para entrar na sala agora. Tente de novo.",
    );
  });
});

describe("coordenador bot: tela legível, escolha só do host", () => {
  it("host escolhe depois da cortina + 2,5–3,0 s de tela", () => {
    const host = botPickDelayMs(true, PHASE_ANNOUNCER_TOTAL_MS);
    const curtainOut = 2800 + 450; // cortina na tela + saída (PhaseAnnouncer)
    expect(host - curtainOut).toBeGreaterThanOrEqual(2500);
    expect(host - curtainOut).toBeLessThanOrEqual(3000);
    expect(host).toBe(PHASE_ANNOUNCER_TOTAL_MS + BOT_COORDINATOR_HOLD_MS);
  });
  it("os demais só cobrem a falta do host bem depois", () => {
    expect(botPickDelayMs(false, PHASE_ANNOUNCER_TOTAL_MS)).toBe(
      botPickDelayMs(true, PHASE_ANNOUNCER_TOTAL_MS) + BOT_PICK_GUEST_EXTRA_MS,
    );
    expect(BOT_PICK_GUEST_EXTRA_MS).toBeGreaterThanOrEqual(3000);
  });
});

describe("tema claro como padrão, sem flash", () => {
  const run = () => new Function(THEME_BOOT_SCRIPT)();
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    document.head.innerHTML = '<meta name="theme-color" content="#000000">';
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("primeira visita (nada salvo) → CLARO", () => {
    run();
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(
      document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute("content"),
    ).toBe("#fbf3e3");
  });
  it("escuro salvo continua escuro (não sobrescreve a escolha)", () => {
    localStorage.setItem("verbete:theme", "dark");
    document.documentElement.classList.add("light"); // padrão do servidor
    run();
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("verbete:theme")).toBe("dark");
    expect(
      document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute("content"),
    ).toBe("#150a2c");
  });
  it("claro salvo → claro; armazenamento bloqueado → claro", () => {
    localStorage.setItem("verbete:theme", "light");
    run();
    expect(document.documentElement.classList.contains("light")).toBe(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    document.documentElement.className = "";
    run();
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
  it("não usa prefers-color-scheme como padrão e o hook concorda", () => {
    expect(THEME_BOOT_SCRIPT).not.toMatch(/prefers-color-scheme/);
    const hook = readFileSync(join(root, "src/hooks/use-theme.ts"), "utf8");
    expect(hook).toMatch(/let currentTheme: Theme = "light"/);
    expect(hook).toMatch(/getServerSnapshot\(\): Theme \{\s*return "light"/);
    const rootTsx = readFileSync(join(root, "src/routes/__root.tsx"), "utf8");
    expect(rootTsx).toMatch(/\{ children: THEME_BOOT_SCRIPT \}/);
    expect(rootTsx).toMatch(/className="light"/);
  });
});

describe("Verbete = 4 a 12 jogadores em tudo que é público", () => {
  const PUBLIC = [
    "src/routes/__root.tsx",
    "src/routes/index.tsx",
    "public/manifest.webmanifest",
    "scripts/social-preview-sim.mjs",
    "SETUP.md",
  ];
  it("nenhum '2 a 12' / mínimo 2 sobrou", () => {
    for (const f of PUBLIC) {
      const t = readFileSync(join(root, f), "utf8");
      expect(t, f).not.toMatch(
        /\b2 a 12\b|2[–-]12 jogadores|m[íi]n(imo|\.)\s*2\b/i,
      );
    }
  });
  it("Home, meta, Open Graph e manifest dizem 4 a 12", () => {
    const rootTsx = readFileSync(join(root, "src/routes/__root.tsx"), "utf8");
    expect(rootTsx.match(/4 a 12 jogadores/g)?.length).toBe(3); // meta + og + twitter
    const home = readFileSync(join(root, "src/routes/index.tsx"), "utf8");
    expect(home).toMatch(/4 a 12 jogadores · Conta opcional/);
    expect(home.match(/4 a 12 jogadores/g)?.length).toBe(3);
    const manifest = JSON.parse(
      readFileSync(join(root, "public/manifest.webmanifest"), "utf8"),
    ) as { description: string; background_color: string };
    expect(manifest.description).toMatch(/4 a 12 jogadores/);
    expect(manifest.background_color).toBe("#fbf3e3");
  });
});
