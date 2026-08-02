// Troféu da marca (aprovado 2026-08-02, prévia B): taça dourada com contorno
// branco e brilho rosa-roxo — substitui o emoji 📊 no título do Placar.
export function TrophyIcon({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden
      style={{
        filter:
          "drop-shadow(0 3px 0 rgba(76,0,128,0.45)) drop-shadow(0 6px 14px rgba(255,0,150,0.35))",
      }}
    >
      <defs>
        <linearGradient id="placar-trophy-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe27a" />
          <stop offset="0.5" stopColor="#ffc93c" />
          <stop offset="1" stopColor="#f5a623" />
        </linearGradient>
      </defs>
      <path
        d="M16 10h32v6c0 12-6 20-12 22v6h-8v-6c-6-2-12-10-12-22v-6z"
        fill="url(#placar-trophy-gold)"
        stroke="#fff"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <path
        d="M16 14h-6c0 8 3 13 8 15"
        stroke="#fff"
        strokeWidth="3.5"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M48 14h6c0 8-3 13-8 15"
        stroke="#fff"
        strokeWidth="3.5"
        fill="none"
        strokeLinecap="round"
      />
      <rect
        x="24"
        y="46"
        width="16"
        height="4"
        rx="2"
        fill="url(#placar-trophy-gold)"
        stroke="#fff"
        strokeWidth="3"
      />
      <rect
        x="19"
        y="50"
        width="26"
        height="7"
        rx="3"
        fill="url(#placar-trophy-gold)"
        stroke="#fff"
        strokeWidth="3.5"
      />
      <path
        d="M30 20l2.2 4.6 5 .6-3.7 3.4 1 4.9-4.5-2.5-4.5 2.5 1-4.9-3.7-3.4 5-.6z"
        fill="#fff"
        opacity="0.9"
      />
    </svg>
  );
}
