import { motion } from "framer-motion";
import { memo } from "react";

interface AvatarBubbleProps {
  emoji: string;
  color: string;
  size?: number;
  isCoordinator?: boolean;
  isYou?: boolean;
  label?: string;
  score?: number;
  className?: string;
}

function AvatarBubbleImpl({
  emoji, color, size = 64, isCoordinator, isYou, label, score, className = "",
}: AvatarBubbleProps) {
  return (
    <div className={"flex flex-col items-center gap-1 " + className}>
      <motion.div
        whileTap={{ scale: 0.92 }}
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        className="relative rounded-full flex items-center justify-center shadow-pop"
        style={{
          width: size, height: size,
          background: `radial-gradient(circle at 30% 25%, ${color}cc, ${color})`,
          border: "3px solid rgba(0,0,0,0.4)",
        }}
      >
        <span style={{ fontSize: size * 0.55 }}>{emoji}</span>
        {isCoordinator && (
          <motion.span
            className="absolute -top-3 -right-1 text-2xl"
            animate={{ rotate: [-10, 10, -10] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          >👑</motion.span>
        )}
        {isYou && (
          <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-display bg-pink text-primary-foreground px-2 py-0.5 rounded-full border border-black/40">
            VC
          </span>
        )}
      </motion.div>
      {label && (
        <span className="text-xs font-display max-w-[80px] truncate text-center">
          {label}
        </span>
      )}
      {typeof score === "number" && (
        <span className="text-xs font-bold text-sun">{score} pts</span>
      )}
    </div>
  );
}

export const AvatarBubble = memo(AvatarBubbleImpl);


