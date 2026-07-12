// Toast leve para exibir conquista desbloqueada. Empilha múltiplas e some sozinho.
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { Achievement } from "@/lib/daily";

type ToastItem = { id: number; achievement: Achievement };
let pushFn: ((a: Achievement) => void) | null = null;

export function pushAchievement(a: Achievement) {
  if (pushFn) pushFn(a);
}

export function AchievementToaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    pushFn = (a) => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { id, achievement: a }]);
      setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 4200);
    };
    return () => { pushFn = null; };
  }, []);

  return (
    <div className="pointer-events-none fixed top-3 inset-x-0 z-[80] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {items.map((it) => (
          <motion.div key={it.id}
            initial={{ y: -60, opacity: 0, scale: 0.8 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -20, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 22 }}
            className="pointer-events-auto sticker bg-gradient-fun text-white shadow-pop flex items-center gap-3 py-2 px-3 max-w-sm w-full">
            <span className="text-3xl">{it.achievement.emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="font-display text-xs uppercase tracking-wider opacity-90">Conquista desbloqueada!</p>
              <p className="font-display text-base leading-tight truncate">{it.achievement.name}</p>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}


