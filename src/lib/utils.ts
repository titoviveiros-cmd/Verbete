import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { CSSProperties } from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Empurra a faixa onde o navegador desenha a barra de rolagem para fora da
 * área visível (clipada pelo ancestral com overflow:hidden — o shell da sala
 * ou o painel do chat). Necessário porque o Edge com barras overlay/Fluent
 * desenha a barra durante a interação MESMO com scrollbar-width:none.
 * `visibleInset` = distância entre a borda do scroller e a borda de clip
 * (padding direito do ancestral). Estilo inline para vencer qualquer
 * utilitário de width/padding do Tailwind.
 */
export function scrollbarClip(
  visibleInset = "max(1rem, env(safe-area-inset-right, 0px))",
): CSSProperties {
  const clip = `(${visibleInset} + 24px)`;
  return {
    marginRight: `calc(-1 * ${clip})`,
    paddingRight: `calc(${clip})`,
    width: `calc(100% + ${clip})`,
    maxWidth: `calc(100% + ${clip})`,
  };
}
