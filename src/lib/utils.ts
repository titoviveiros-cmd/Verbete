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
 *
 * `ringGutter` (opcional): a lista também avança esse tanto para a ESQUERDA
 * e o devolve como padding — o conteúdo fica no mesmo lugar, mas o anel e o
 * brilho da carta na borda esquerda cabem antes do corte (ver .ring-room).
 */
export function scrollbarClip(
  visibleInset = "max(1rem, env(safe-area-inset-right, 0px))",
  ringGutter?: string,
): CSSProperties {
  const clip = `(${visibleInset} + 24px)`;
  const g = ringGutter ? ` + ${ringGutter}` : "";
  return {
    ...(ringGutter
      ? { marginLeft: `calc(-1 * ${ringGutter})`, paddingLeft: ringGutter }
      : {}),
    marginRight: `calc(-1 * ${clip})`,
    paddingRight: `calc(${clip})`,
    width: `calc(100% + ${clip}${g})`,
    maxWidth: `calc(100% + ${clip}${g})`,
  };
}

/** Respiro de anel/brilho das listas da sala (o mesmo de .ring-room). */
export const RING_GUTTER = "var(--ring-gutter)";
