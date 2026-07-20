import { useEffect, useState } from "react";
import { useTheme } from "@/hooks/use-theme";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = theme === "dark";
  return (
    <button
      onClick={toggle}
      title={isDark ? "Mudar para tema claro" : "Mudar para tema escuro"}
      aria-label={isDark ? "Mudar para tema claro" : "Mudar para tema escuro"}
      className={
        "opacity-60 hover:opacity-100 text-base w-8 h-8 flex items-center justify-center rounded-full bg-card/50 border border-white/10 transition " +
        className
      }
      suppressHydrationWarning
    >
      <span suppressHydrationWarning>
        {mounted ? (isDark ? "☀️" : "🌙") : ""}
      </span>
    </button>
  );
}
