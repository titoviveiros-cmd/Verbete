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

/** Barra a pinça no Safari iOS (gesturestart/gesturechange só existem lá). */
export function blockIosPinchZoom(doc: Document = document): () => void {
  const block = (e: Event) => e.preventDefault();
  const opts = { passive: false } as const;
  doc.addEventListener("gesturestart", block, opts);
  doc.addEventListener("gesturechange", block, opts);
  return () => {
    doc.removeEventListener("gesturestart", block);
    doc.removeEventListener("gesturechange", block);
  };
}
