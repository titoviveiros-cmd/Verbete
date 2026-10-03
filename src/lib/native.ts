// Comportamentos exclusivos do app nativo (Capacitor). No web é no-op.
import { Capacitor } from "@capacitor/core";
import { APP_URL } from "./app-url";

let installed = false;

const LAUNCH_HANDLED_KEY = "verbete:launch-url-handled";

/** Caminho interno (pathname+search) de um App Link do próprio app, ou null. */
export function appPathFromLink(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.host !== new URL(APP_URL).host) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

function openAppLink(url: string) {
  const path = appPathFromLink(url);
  if (!path) return;
  if (path === window.location.pathname + window.location.search) return;
  window.location.href = path;
}

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

  // App Links (https://jogo.verbete.workers.dev/?join=1234) com o app JÁ
  // aberto chegam como evento — o WebView não navega sozinho.
  void App.addListener("appUrlOpen", ({ url }) => openAppLink(url));

  // App FECHADO aberto pelo link (ex.: convite no WhatsApp): o appUrlOpen não
  // dispara; a URL vem em getLaunchUrl(). Ela continua sendo devolvida a cada
  // recarga do WebView (ex.: auto-update), então aplicamos uma vez por sessão.
  try {
    const launch = await App.getLaunchUrl();
    if (!launch?.url) return;
    let already = false;
    try {
      already = sessionStorage.getItem(LAUNCH_HANDLED_KEY) === launch.url;
      sessionStorage.setItem(LAUNCH_HANDLED_KEY, launch.url);
    } catch {
      /* storage indisponível: segue com a navegação única desta carga */
    }
    if (!already) openAppLink(launch.url);
  } catch {
    // plugin sem suporte/erro de intent: o app abre na home, como antes
  }
}
