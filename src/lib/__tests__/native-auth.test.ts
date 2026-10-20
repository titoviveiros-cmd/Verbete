import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Retorno do login no app nativo: app.verbete.game://auth/callback?code=...
// (cold start por getLaunchUrl, app aberto por appUrlOpen).
const listeners: Record<string, (ev: { url?: string }) => void> = {};
const app = {
  addListener: vi.fn((name: string, cb: (ev: { url?: string }) => void) => {
    listeners[name] = cb;
    return Promise.resolve({ remove: () => {} });
  }),
  minimizeApp: vi.fn(),
  getLaunchUrl: vi.fn(),
};
const order: string[] = [];
const exchange = vi.fn(async (code: string) => {
  order.push(`exchange:${code}`);
  return code === "ruim"
    ? { error: { message: "invalid flow state" } }
    : { error: null };
});
const ensureAnon = vi.fn(async () => {
  order.push("anon");
  return true;
});

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock("@capacitor/app", () => ({ App: app }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { exchangeCodeForSession: exchange } },
}));
vi.mock("../auth-session", () => ({ ensureAnonSession: ensureAnon }));

const realLocation = window.location;
let loc: { pathname: string; search: string; href: string };
const CB = "app.verbete.game://auth/callback";

async function freshInstall() {
  vi.resetModules();
  const mod = await import("../native");
  await mod.installNativeHandlers();
  return mod;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sessionStorage.clear();
  order.length = 0;
  exchange.mockClear();
  ensureAnon.mockClear();
  app.getLaunchUrl.mockReset();
  app.addListener.mockClear();
  loc = { pathname: "/login", search: "", href: "https://localhost/login" };
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

describe("retorno do Google com o app FECHADO (cold start)", () => {
  it("troca o código pela sessão e abre o perfil", async () => {
    app.getLaunchUrl.mockResolvedValue({ url: `${CB}?code=abc123` });
    await freshInstall();
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith("abc123");
    expect(loc.href).toBe("/profile");
  });

  it("a sessão anônima do boot termina ANTES da troca (não sobrescreve a conta)", async () => {
    app.getLaunchUrl.mockResolvedValue({ url: `${CB}?code=ordem` });
    await freshInstall();
    expect(order).toEqual(["anon", "exchange:ordem"]);
  });

  it("recarga do WebView (mesma URL de lançamento) não troca o código de novo", async () => {
    app.getLaunchUrl.mockResolvedValue({ url: `${CB}?code=uma-vez` });
    await freshInstall();
    loc.pathname = "/profile";
    loc.href = "untouched";
    await freshInstall();
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(loc.href).toBe("untouched");
  });
});

describe("retorno do Google com o app ABERTO (appUrlOpen)", () => {
  it("troca o código e abre o perfil", async () => {
    app.getLaunchUrl.mockResolvedValue(undefined);
    await freshInstall();
    listeners.appUrlOpen?.({ url: `${CB}?code=quente` });
    await flush();
    expect(exchange).toHaveBeenCalledWith("quente");
    expect(loc.href).toBe("/profile");
  });

  it("retorno duplicado (cold start + evento) troca uma vez só", async () => {
    app.getLaunchUrl.mockResolvedValue({ url: `${CB}?code=dup` });
    await freshInstall();
    listeners.appUrlOpen?.({ url: `${CB}?code=dup` });
    listeners.appUrlOpen?.({ url: `${CB}?code=dup` });
    await flush();
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

describe("retorno inválido nunca derruba o app", () => {
  it("cancelado/negado no Google: não troca nada e mostra o erro no login", async () => {
    app.getLaunchUrl.mockResolvedValue(undefined);
    const mod = await freshInstall();
    const seen: unknown[] = [];
    window.addEventListener("verbete:auth-callback", (e) =>
      seen.push((e as CustomEvent).detail),
    );
    listeners.appUrlOpen?.({
      url: `${CB}?error=access_denied&error_description=Usuário+cancelou`,
    });
    await flush();
    expect(exchange).not.toHaveBeenCalled();
    expect(seen).toEqual([{ ok: false, error: "Usuário cancelou" }]);
    expect(loc.href).toBe("https://localhost/login"); // já no login: fica
    void mod;
  });

  it("erro no fragmento (#error=...) também é reconhecido", async () => {
    app.getLaunchUrl.mockResolvedValue({
      url: `${CB}#error=server_error&error_description=falhou`,
    });
    loc.pathname = "/";
    await freshInstall();
    expect(exchange).not.toHaveBeenCalled();
    expect(loc.href).toBe("/login");
    const { takePendingAuthError } = await import("../native-auth");
    expect(takePendingAuthError()).toBe("falhou");
  });

  it("sem código: erro, sem troca", async () => {
    app.getLaunchUrl.mockResolvedValue({ url: CB });
    await freshInstall();
    expect(exchange).not.toHaveBeenCalled();
  });

  it("código recusado pelo servidor: erro na tela, sem ir para o perfil", async () => {
    app.getLaunchUrl.mockResolvedValue({ url: `${CB}?code=ruim` });
    await freshInstall();
    expect(exchange).toHaveBeenCalledWith("ruim");
    expect(loc.href).toBe("https://localhost/login");
  });

  it("URL malformada não lança", async () => {
    app.getLaunchUrl.mockResolvedValue({ url: `${CB}?code=%E0%A4%A` });
    await expect(freshInstall()).resolves.toBeDefined();
  });
});

describe("convites (App Links) continuam iguais", () => {
  it("convite /?join= ainda abre a sala e não aciona o login", async () => {
    app.getLaunchUrl.mockResolvedValue(undefined);
    loc.pathname = "/";
    await freshInstall();
    listeners.appUrlOpen?.({
      url: "https://jogo.verbete.workers.dev/?join=4321",
    });
    await flush();
    expect(loc.href).toBe("/?join=4321");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("outro link do esquema próprio (não é o retorno) é ignorado", async () => {
    app.getLaunchUrl.mockResolvedValue(undefined);
    await freshInstall();
    listeners.appUrlOpen?.({ url: "app.verbete.game://room/1234?code=xyz" });
    await flush();
    expect(exchange).not.toHaveBeenCalled();
    expect(loc.href).toBe("https://localhost/login");
  });
});
