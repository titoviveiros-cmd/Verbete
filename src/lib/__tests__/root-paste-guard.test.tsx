// Integração: a raiz REAL do app (src/routes/__root.tsx) instala o anti-trapaça.
// Eventos de colar/arrastar de verdade são disparados no documento e conferimos
// se foram cancelados. Isso cobre a ligação do paste-guard com a raiz (rota atual
// lida de window.location, tipo do evento, fase de captura), não só a função.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { ADMIN_PASTE_MARK } from "@/lib/paste-guard";

// efeitos colaterais da raiz que não interessam aqui (áudio, sessão, nativo, telemetria)
vi.mock("@/lib/sound", () => ({
  installAudioUnlock: vi.fn(),
  playUITap: vi.fn(),
  vibrate: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => ({ ensureAnonSession: vi.fn() }));
vi.mock("@/lib/native", () => ({ installNativeHandlers: vi.fn() }));
vi.mock("@/lib/ops", () => ({ installOpsCapture: vi.fn() }));
vi.mock("@/components/RemoteGate", () => ({
  RemoteGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("@/components/AchievementToaster", () => ({
  AchievementToaster: () => null,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));

import { Route as RootRoute } from "@/routes/__root";

// a casca original volta ao fim do arquivo (o Route é um objeto de módulo)
const shellOriginal = (RootRoute.options as { shellComponent?: unknown })
  .shellComponent;
afterAll(() => {
  RootRoute.update({ shellComponent: shellOriginal } as never);
});

function Campos() {
  return (
    <div>
      <textarea aria-label="marcado" data-allow-paste={ADMIN_PASTE_MARK} />
      <textarea aria-label="comum" />
      <input aria-label="resposta" />
    </div>
  );
}

async function montar(path: string) {
  // a casca <html> da raiz não cabe dentro do container do teste: só o conteúdo
  RootRoute.update({
    shellComponent: ({ children }: { children: React.ReactNode }) => children,
  } as never);
  const filhos = [
    createRoute({
      getParentRoute: () => RootRoute,
      path: "/admin/daily-choices",
      component: Campos,
    }),
    createRoute({
      getParentRoute: () => RootRoute,
      path: "/daily",
      component: Campos,
    }),
  ];
  const router = createRouter({
    routeTree: RootRoute.addChildren(filhos),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: new QueryClient() },
  });
  // o guard lê window.location (como no app); a memória do router não mexe nela
  window.history.pushState({}, "", path);
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  await screen.findByLabelText("marcado");
}

/** Dispara o evento como o navegador faz (borbulha, cancelável) e diz se foi cancelado. */
function cancelado(alvo: Element, tipo: "paste" | "drop") {
  const ev = new Event(tipo, { bubbles: true, cancelable: true });
  alvo.dispatchEvent(ev);
  return ev.defaultPrevented;
}

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

describe("raiz do app × anti-trapaça (integração)", () => {
  it("no painel admin: colar só no campo marcado; arrastar bloqueado em tudo", async () => {
    await montar("/admin/daily-choices");
    const marcado = screen.getByLabelText("marcado");
    expect(cancelado(marcado, "paste")).toBe(false);
    expect(cancelado(marcado, "drop")).toBe(true);
    expect(cancelado(screen.getByLabelText("comum"), "paste")).toBe(true);
    expect(cancelado(screen.getByLabelText("resposta"), "paste")).toBe(true);
  });

  it("numa tela de jogo: colar bloqueado mesmo em campo marcado", async () => {
    await montar("/daily");
    expect(cancelado(screen.getByLabelText("marcado"), "paste")).toBe(true);
    expect(cancelado(screen.getByLabelText("comum"), "paste")).toBe(true);
    expect(cancelado(screen.getByLabelText("resposta"), "paste")).toBe(true);
    expect(cancelado(screen.getByLabelText("resposta"), "drop")).toBe(true);
  });

  it("ao desmontar a raiz, os ouvintes saem junto", async () => {
    await montar("/daily");
    const solto = document.createElement("textarea");
    document.body.appendChild(solto);
    expect(cancelado(solto, "paste")).toBe(true);
    cleanup();
    expect(cancelado(solto, "paste")).toBe(false);
    solto.remove();
  });
});
