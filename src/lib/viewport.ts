// Escala fixa de app/jogo (decisão de produto, 2º playtest de 2026-10-20):
// sem pinch-zoom, sem duplo toque para ampliar e sem "zoom out" que encolha
// a interface. Antes (Fase 7, WCAG 1.4.4) o zoom ia até 5x; a troca é
// consciente e está registrada no PR #9.
//  - Chrome Android e o WebView do Capacitor respeitam o viewport abaixo.
//  - CSS (styles.css): html { touch-action: pan-x pan-y } tira o duplo toque
//    e a pinça dos gestos, mantendo a rolagem normal.
//  - Safari iOS IGNORA user-scalable=no (acessibilidade do sistema): a pinça
//    só para com o evento proprietário do WebKit (blockIosPinchZoom).
//    maximum-scale=1 ainda impede o zoom automático ao focar um campo.
export const VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content";

// Páginas de LEITURA (Política, Termos, Suporte, Excluir conta — Rodada 2B,
// 2026-10-27): zoom livre para quem precisa ampliar o texto. Cada uma declara
// READING_VIEWPORT no head (o HeadContent do TanStack fica com a meta da rota
// mais profunda, por name) e o RootShell põe PAGE_ZOOM_ATTR no <html> quando o
// caminho é de leitura — já no HTML do servidor: o atributo libera o
// touch-action (styles.css) e a pinça do iOS (abaixo). Ao sair, a meta da raiz
// volta e o atributo sai — o jogo segue em escala fixa.
// No app Android, capacitor.config.ts liga o zoom do WebView (zoomEnabled):
// sem isso a pinça não existe em página nenhuma; nas de jogo quem barra é o
// viewport acima + o touch-action.
export const READING_VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content";
export const READING_VIEWPORT = {
  name: "viewport",
  content: READING_VIEWPORT_CONTENT,
} as const;
export const PAGE_ZOOM_ATTR = "data-page-zoom";
export const READING_PATHS = [
  "/privacy",
  "/terms",
  "/support",
  "/delete-account",
] as const;

export function isReadingPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return (READING_PATHS as readonly string[]).includes(p);
}

/** Barra a pinça no Safari iOS (gesturestart/gesturechange só existem lá). */
export function blockIosPinchZoom(doc: Document = document): () => void {
  const block = (e: Event) => {
    if (doc.documentElement.hasAttribute(PAGE_ZOOM_ATTR)) return;
    e.preventDefault();
  };
  const opts = { passive: false } as const;
  doc.addEventListener("gesturestart", block, opts);
  doc.addEventListener("gesturechange", block, opts);
  return () => {
    doc.removeEventListener("gesturestart", block);
    doc.removeEventListener("gesturechange", block);
  };
}
