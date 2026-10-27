import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeCount,
  botsToMinimum,
  canStartGame,
  MIN_PLAYERS,
  startButtonLabel,
} from "@/lib/game-rules";
import {
  blockIosPinchZoom,
  isReadingPath,
  PAGE_ZOOM_ATTR,
  READING_PATHS,
  READING_VIEWPORT_CONTENT,
  VIEWPORT_CONTENT,
} from "@/lib/viewport";

// Ajustes finais do 2º playtest (2026-10-20): mínimo de 4 participantes,
// escala fixa de jogo (sem zoom) — sem mexer em scoring, bots ou Revelação.
const seats = (n: number, kicked = 0) =>
  Array.from({ length: n + kicked }, (_, i) => ({
    kicked_at: i < kicked ? "2026-10-20T00:00:00Z" : null,
  }));

describe("mínimo de 4 participantes (humanos + bots)", () => {
  it("1, 2 e 3 não iniciam; 4 inicia", () => {
    expect(MIN_PLAYERS).toBe(4);
    for (const n of [1, 2, 3]) expect(canStartGame(seats(n))).toBe(false);
    expect(canStartGame(seats(4))).toBe(true);
    expect(canStartGame(seats(12))).toBe(true);
  });

  it("o botão diz quantos faltam: Mín. 4 jogadores (n/4)", () => {
    for (const n of [1, 2, 3])
      expect(
        startButtonLabel({ count: n, starting: false, teamsOK: true }),
      ).toBe(`Mín. 4 jogadores (${n}/4)`);
    expect(startButtonLabel({ count: 4, starting: false, teamsOK: true })).toBe(
      "🚀 Começar!",
    );
    expect(
      startButtonLabel({ count: 4, starting: false, teamsOK: false }),
    ).toBe("⚠️ Atribua todos a um time");
    expect(startButtonLabel({ count: 4, starting: true, teamsOK: true })).toBe(
      "Iniciando…",
    );
    // recusa do servidor (bot otimista ainda não chegou ao banco)
    expect(
      startButtonLabel({
        count: 4,
        starting: false,
        teamsOK: true,
        refused: true,
      }),
    ).toBe("Os bots ainda estão entrando — toque de novo");
    expect(
      startButtonLabel({
        count: 3,
        starting: false,
        teamsOK: true,
        refused: true,
      }),
    ).toBe("Mín. 4 jogadores (3/4)");
  });

  it("expulso não conta; 'Encher até 4' completa exatamente o que falta", () => {
    expect(activeCount(seats(3, 2))).toBe(3);
    expect(canStartGame(seats(3, 2))).toBe(false);
    expect(botsToMinimum(seats(1))).toBe(3);
    expect(botsToMinimum(seats(3))).toBe(1);
    expect(botsToMinimum(seats(6))).toBe(0);
  });

  it("o SERVIDOR também recusa: start_game devolve min_players abaixo de 4, depois da checagem de host", () => {
    const dir = join(__dirname, "../../../supabase/migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    let body = "";
    for (const f of files) {
      const t = readFileSync(join(dir, f), "utf8");
      const re =
        /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?start_game\s*\(/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t))) body = t.slice(m.index, m.index + 5000);
    }
    expect(body).toMatch(/kicked_at IS NULL/);
    expect(body).toMatch(/IF v_active < 4 THEN/);
    expect(body).toMatch(/'reason', 'min_players'/);
    // não-host continua recebendo not_authorized (a ordem importa)
    expect(body.indexOf("not_authorized")).toBeLessThan(
      body.indexOf("min_players"),
    );
  });
});

describe("escala fixa de jogo (sem zoom)", () => {
  it("viewport sem zoom, mantendo largura, safe-area e teclado redimensionando", () => {
    for (const part of [
      "width=device-width",
      "initial-scale=1",
      "minimum-scale=1",
      "maximum-scale=1",
      "user-scalable=no",
      "viewport-fit=cover",
      "interactive-widget=resizes-content",
    ])
      expect(VIEWPORT_CONTENT).toContain(part);
  });

  it("CSS: sem pinça e sem duplo toque, mas a rolagem (pan) continua", () => {
    const css = readFileSync(join(__dirname, "../../styles.css"), "utf8");
    expect(css).toMatch(/html\s*\{\s*touch-action:\s*pan-x pan-y;\s*\}/);
    // só as páginas de leitura liberam (atributo posto por allowPageZoom)
    expect(css).toMatch(
      /html\[data-page-zoom\]\s*\{\s*touch-action:\s*auto;\s*\}/,
    );
  });

  it("páginas de leitura: viewport com zoom e só elas declaram (Rodada 2B)", () => {
    expect(READING_VIEWPORT_CONTENT).not.toMatch(
      /user-scalable|maximum-scale|minimum-scale/,
    );
    for (const part of [
      "width=device-width",
      "initial-scale=1",
      "viewport-fit=cover",
    ])
      expect(READING_VIEWPORT_CONTENT).toContain(part);
    const routes = join(__dirname, "../../routes");
    const reading = ["privacy", "terms", "support", "delete-account"];
    for (const f of readdirSync(routes).filter((x) => x.endsWith(".tsx"))) {
      const src = readFileSync(join(routes, f), "utf8");
      const isReading = reading.includes(f.replace(/\.tsx$/, ""));
      expect(src.includes("READING_VIEWPORT,"), f).toBe(isReading);
    }
    expect([...READING_PATHS].sort()).toEqual(
      reading.map((r) => "/" + r).sort(),
    );
    for (const p of ["/privacy", "/terms/", "/support", "/delete-account"])
      expect(isReadingPath(p), p).toBe(true);
    for (const p of [
      "/",
      "/room/1234",
      "/daily",
      "/profile",
      "/login",
      "/privacy-x",
      "/download",
    ])
      expect(isReadingPath(p), p).toBe(false);
    const root = readFileSync(join(routes, "__root.tsx"), "utf8");
    expect(root).toContain("isReadingPath(s.location.pathname)");
    expect(root).toContain('[PAGE_ZOOM_ATTR]: ""');
    const cap = readFileSync(
      join(__dirname, "../../../capacitor.config.ts"),
      "utf8",
    );
    expect(cap).toMatch(/zoomEnabled:\s*true/);
  });

  it("Safari iOS: a pinça (gesturestart/gesturechange) é barrada e o bloqueio se desfaz", () => {
    const undo = blockIosPinchZoom(document);
    const ev = new Event("gesturestart", { cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const ch = new Event("gesturechange", { cancelable: true });
    document.dispatchEvent(ch);
    expect(ch.defaultPrevented).toBe(true);
    // página de leitura (Rodada 2B): com o atributo, a pinça passa
    document.documentElement.setAttribute(PAGE_ZOOM_ATTR, "");
    const legal = new Event("gesturestart", { cancelable: true });
    document.dispatchEvent(legal);
    expect(legal.defaultPrevented).toBe(false);
    document.documentElement.removeAttribute(PAGE_ZOOM_ATTR);
    const back = new Event("gesturechange", { cancelable: true });
    document.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    undo();
    const after = new Event("gesturestart", { cancelable: true });
    document.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    // rolagem/toque comum nunca é barrado
    const touch = new Event("touchmove", { cancelable: true });
    document.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
  });
});
