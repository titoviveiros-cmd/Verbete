import { motion } from "framer-motion";

interface MascotProps {
  mood?: "idle" | "excited" | "thinking" | "wow" | "sad";
  size?: number;
  className?: string;
}

/**
 * Verbete — Livro Mascote.
 * Pseudo-3D book SVG with eyes that change with mood.
 */
export function Mascot({
  mood = "idle",
  size = 160,
  className = "",
}: MascotProps) {
  const isThink = mood === "thinking";
  const isWow = mood === "wow";
  const isSad = mood === "sad";

  return (
    <motion.div
      className={"relative inline-block " + className}
      aria-hidden
      style={{ width: size, height: size }}
      animate={{
        y: [0, -8, 0],
        rotate: mood === "excited" ? [-4, 4, -4] : [-2, 2, -2],
      }}
      transition={{
        duration: mood === "excited" ? 0.6 : 3,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    >
      <svg viewBox="0 0 200 200" width={size} height={size}>
        {/* shadow */}
        <ellipse cx="100" cy="180" rx="60" ry="8" fill="#000" opacity="0.35" />

        {/* book back cover */}
        <g transform="translate(20 30)">
          <rect
            x="0"
            y="0"
            width="160"
            height="120"
            rx="12"
            fill="#7B2CBF"
            stroke="#3A0A60"
            strokeWidth="4"
          />
          {/* pages stack */}
          <rect x="6" y="6" width="148" height="108" rx="8" fill="#FFF6E0" />
          <rect x="10" y="10" width="140" height="100" rx="6" fill="#FFFCEF" />

          {/* spine highlight */}
          <rect
            x="76"
            y="0"
            width="8"
            height="120"
            fill="#3A0A60"
            opacity="0.6"
          />

          {/* face */}
          <g transform="translate(80 60)">
            {/* left eye */}
            <circle
              cx="-22"
              cy="0"
              r="14"
              fill="#fff"
              stroke="#1A0936"
              strokeWidth="3"
            />
            <motion.circle
              cx="-22"
              cy="0"
              r={isWow ? 8 : 6}
              fill="#1A0936"
              animate={isThink ? { cx: [-26, -18, -26] } : {}}
              transition={{ duration: 2, repeat: Infinity }}
            />
            {/* right eye */}
            <circle
              cx="22"
              cy="0"
              r="14"
              fill="#fff"
              stroke="#1A0936"
              strokeWidth="3"
            />
            <motion.circle
              cx="22"
              cy="0"
              r={isWow ? 8 : 6}
              fill="#1A0936"
              animate={isThink ? { cx: [18, 26, 18] } : {}}
              transition={{ duration: 2, repeat: Infinity }}
            />
            {/* mouth */}
            {isSad ? (
              <path
                d="M -14 26 Q 0 16 14 26"
                stroke="#1A0936"
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
              />
            ) : isWow ? (
              <ellipse cx="0" cy="26" rx="8" ry="10" fill="#1A0936" />
            ) : (
              <path
                d="M -14 22 Q 0 36 14 22"
                stroke="#1A0936"
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
              />
            )}
            {/* cheeks */}
            <circle cx="-30" cy="18" r="5" fill="#FF85A2" opacity="0.6" />
            <circle cx="30" cy="18" r="5" fill="#FF85A2" opacity="0.6" />
          </g>
        </g>

        {/* sparkles */}
        {mood === "excited" && (
          <>
            <motion.text
              x="20"
              y="40"
              fontSize="22"
              animate={{ opacity: [0, 1, 0], y: [40, 20, 0] }}
              transition={{ duration: 1.4, repeat: Infinity }}
            >
              ✨
            </motion.text>
            <motion.text
              x="160"
              y="50"
              fontSize="22"
              animate={{ opacity: [0, 1, 0], y: [50, 30, 10] }}
              transition={{ duration: 1.4, repeat: Infinity, delay: 0.3 }}
            >
              ⭐
            </motion.text>
          </>
        )}
      </svg>
    </motion.div>
  );
}
