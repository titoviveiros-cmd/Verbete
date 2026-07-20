import type { CSSProperties } from "react";

// Marca canônica do Verbete — referência: hero da Home (diretriz 2026-07-19).
// FONTE ÚNICA da identidade: o tile "V" com livro e o wordmark branco com
// contorno/sombra roxos. Toda ocorrência da marca no app deriva daqui;
// variantes locais (ex.: texto com gradiente) foram eliminadas na Fase 3.

const ROXO = "#4c1a8f";

/** Estilo do wordmark "Verbete" (branco bubbly, contorno e sombra roxos).
 *  Contorno/sombras escalam com o tamanho para manter a proporção do hero. */
export function verbeteWordmarkStyle(
  size: number | string = "clamp(56px, 16vw, 80px)",
): CSSProperties {
  const n = typeof size === "number" ? size : 80;
  const s = Math.max(0.4, Math.min(1, n / 80));
  return {
    fontSize: size,
    color: "#ffffff",
    WebkitTextStroke: `${Math.max(2, Math.round(4 * s))}px ${ROXO}`,
    paintOrder: "stroke fill",
    filter: `drop-shadow(0 ${Math.max(3, Math.round(6 * s))}px 0 ${ROXO}) drop-shadow(0 ${Math.round(12 * s)}px ${Math.round(24 * s)}px rgba(76,26,143,0.55))`,
    letterSpacing: "-0.02em",
  };
}

/** Wordmark pronto (span). Para h1/h2 animados, use verbeteWordmarkStyle. */
export function VerbeteWordmark({
  size,
  className = "",
}: {
  size?: number | string;
  className?: string;
}) {
  return (
    <span
      className={
        "font-display font-black leading-none select-none " + className
      }
      style={verbeteWordmarkStyle(size)}
    >
      Verbete
    </span>
  );
}

/** Tile "V" com livro aberto — proporções derivadas do original de 124px. */
export function VerbeteTile({
  size = 124,
  glow = true,
}: {
  size?: number;
  glow?: boolean;
}) {
  const s = size / 124;
  return (
    <div
      className="relative flex flex-col items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(10, 28 * s),
        background:
          "linear-gradient(135deg, #ff4bb0 0%, #c026d3 50%, #6a1fd4 100%)",
        border: `${Math.max(2, Math.round(5 * s))}px solid #ffffff`,
        boxShadow:
          (glow ? `0 0 ${Math.round(40 * s)}px rgba(255,0,150,0.65), ` : "") +
          `0 ${Math.round(12 * s)}px 0 rgba(76,0,128,0.35), inset 0 ${Math.max(1, Math.round(3 * s))}px 0 rgba(255,255,255,0.35)`,
      }}
    >
      <span
        className="font-display font-black leading-none select-none"
        style={{
          color: "#ffffff",
          fontSize: 82 * s,
          marginTop: -6 * s,
          marginBottom: -6 * s,
          letterSpacing: "-0.05em",
          filter: `drop-shadow(0 ${Math.max(1, Math.round(4 * s))}px 0 rgba(76,0,128,0.35))`,
        }}
      >
        V
      </span>
      {/* livro aberto */}
      <svg
        width={60 * s}
        height={20 * s}
        viewBox="0 0 60 20"
        fill="none"
        aria-hidden
      >
        <path d="M2 16 Q15 8 29 14 L29 6 Q15 0 2 8 Z" fill="#ffffff" />
        <path d="M58 16 Q45 8 31 14 L31 6 Q45 0 58 8 Z" fill="#ffffff" />
        <line x1="30" y1="6" x2="30" y2="16" stroke="#ffffff" strokeWidth="2" />
      </svg>
    </div>
  );
}
