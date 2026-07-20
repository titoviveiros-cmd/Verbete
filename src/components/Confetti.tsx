import { motion } from "framer-motion";
import { useMemo } from "react";

const COLORS = [
  "#FF5C8A",
  "#FFD166",
  "#06D6A0",
  "#118AB2",
  "#A155F0",
  "#F58A07",
];

export function Confetti({ count = 40 }: { count?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }).map((_, i) => ({
        id: i,
        x: Math.random() * 100,
        delay: Math.random() * 0.5,
        color: COLORS[i % COLORS.length],
        rot: Math.random() * 360,
      })),
    [count],
  );

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden z-[60]">
      {pieces.map((p) => (
        <motion.span
          key={p.id}
          initial={{ y: -50, x: `${p.x}vw`, opacity: 1, rotate: 0 }}
          animate={{ y: "110vh", rotate: p.rot + 720 }}
          transition={{
            duration: 2.4 + Math.random() * 1.5,
            delay: p.delay,
            ease: "easeIn",
          }}
          className="absolute block"
          style={{
            width: 10,
            height: 16,
            background: p.color,
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
}
