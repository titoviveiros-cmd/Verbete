import { useSyncExternalStore } from "react";

type Theme = "dark" | "light";
const STORAGE_KEY = "verbete:theme";

const listeners = new Set<() => void>();
let currentTheme: Theme = "dark";

function readInitial(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "dark";
}

function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (t === "light") root.classList.add("light");
  else root.classList.remove("light");
  const color = t === "light" ? "#fbf3e3" : "#1a0f2e";
  let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = color;
  root.style.colorScheme = t === "light" ? "light" : "dark";
}

function setThemeGlobal(t: Theme) {
  currentTheme = t;
  applyTheme(t);
  try { localStorage.setItem(STORAGE_KEY, t); } catch {}
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): Theme { return currentTheme; }
function getServerSnapshot(): Theme { return "dark"; }

// Aplica imediatamente (antes do React montar) para evitar flash.
if (typeof window !== "undefined") {
  try {
    currentTheme = readInitial();
    applyTheme(currentTheme);
  } catch {}
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const toggle = () => setThemeGlobal(theme === "dark" ? "light" : "dark");
  const setTheme = (t: Theme) => setThemeGlobal(t);
  return { theme, toggle, setTheme };
}


