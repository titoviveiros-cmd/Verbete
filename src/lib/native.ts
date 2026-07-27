// Comportamentos exclusivos do app nativo (Capacitor). No web é no-op.
import { Capacitor } from "@capacitor/core";

let installed = false;

/** Botão voltar do Android + roteamento de deep links (/?join=CODIGO). */
export async function installNativeHandlers() {
  if (installed || !Capacitor.isNativePlatform()) return;
  installed = true;
  const { App } = await import("@capacitor/app");

  // Botão voltar: navega no histórico; na raiz, minimiza (padrão Android —
  // nunca "fecha" o app no meio de uma partida por engano).
  void App.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) window.history.back();
    else void App.minimizeApp();
  });

  // App Links (https://jogo.verbete.workers.dev/?join=1234) chegam como
  // evento — o WebView não navega sozinho. Reaproveita a mesma URL no SPA.
  void App.addListener("appUrlOpen", ({ url }) => {
    try {
      const u = new URL(url);
      window.location.href = u.pathname + u.search;
    } catch {
      // URL malformada de intent externo: ignora
    }
  });
}
