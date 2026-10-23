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
        "glass-tile text-base w-8 h-8 max-[380px]:w-[30px] max-[380px]:h-[30px] sm:w-9 sm:h-9 flex items-center justify-center rounded-full active:translate-y-px transition " +
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
