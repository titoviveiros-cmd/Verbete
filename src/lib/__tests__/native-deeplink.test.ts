import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Record<
  string,
  (ev: { url?: string; canGoBack?: boolean }) => void
> = {};
const app = {
  addListener: vi.fn((name: string, cb: (ev: { url?: string }) => void) => {
    listeners[name] = cb;
    return Promise.resolve({ remove: () => {} });
  }),
  minimizeApp: vi.fn(),
  getLaunchUrl: vi.fn(),
};
let native = true;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native },
}));
vi.mock("@capacitor/app", () => ({ App: app }));

const realLocation = window.location;
let loc: { pathname: string; search: string; href: string };

async function freshInstall() {
  vi.resetModules();
  const mod = await import("../native");
  await mod.installNativeHandlers();
  return mod;
}

beforeEach(() => {
  native = true;
  sessionStorage.clear();
  app.getLaunchUrl.mockReset();
  app.addListener.mockClear();
  loc = { pathname: "/", search: "", href: "https://localhost/" };
  Object.defineProperty(window, "location", {
    value: loc,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: realLocation,
    configurable: true,
  });
});

describe("deep link com o app FECHADO (getLaunchUrl)", () => {
  it("abre a sala do convite no cold start", async () => {
    app.getLaunchUrl.mockResolvedValue({
      url: "https://jogo.verbete.workers.dev/?join=1234",
    });
    await freshInstall();
    expect(loc.href).toBe("/?join=1234");
  });

  it("não entra em laço: a recarga seguinte (mesma URL de lançamento) não navega de novo", async () => {
    app.getLaunchUrl.mockResolvedValue({
      url: "https://jogo.verbete.workers.dev/?join=1234",
    });
    await freshInstall();
    loc.href = "untouched";
    loc.pathname = "/room/1234";
    await freshInstall();
    expect(loc.href).toBe("untouched");
  });

  it("ignora link de outro domínio", async () => {
    app.getLaunchUrl.mockResolvedValue({
      url: "https://evil.example/?join=6666",
    });
    await freshInstall();
    expect(loc.href).toBe("https://localhost/");
  });

  it("sem URL de lançamento, abre na home normalmente", async () => {
    app.getLaunchUrl.mockResolvedValue(undefined);
    await freshInstall();
    expect(loc.href).toBe("https://localhost/");
  });
});

describe("deep link com o app ABERTO (appUrlOpen)", () => {
  it("roteia o convite recebido para o SPA", async () => {
    app.getLaunchUrl.mockResolvedValue(undefined);
    await freshInstall();
    listeners.appUrlOpen?.({
      url: "https://jogo.verbete.workers.dev/?join=4321",
    });
    expect(loc.href).toBe("/?join=4321");
  });
});

describe("no navegador (não nativo)", () => {
  it("não registra nada", async () => {
    native = false;
    await freshInstall();
    expect(app.addListener).not.toHaveBeenCalled();
    expect(app.getLaunchUrl).not.toHaveBeenCalled();
  });
});
