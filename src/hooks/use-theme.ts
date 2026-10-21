import { useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";

const isNativePlatform = () => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

type Theme = "dark" | "light";
const STORAGE_KEY = "verbete:theme";

const listeners = new Set<() => void>();
// Padrão CLARO (decisão de produto 2026-10-21): sem preferência salva →
// claro; "dark" salvo continua escuro. O script do <head> (__root.tsx,
// THEME_BOOT_SCRIPT) aplica o mesmo antes da primeira pintura.
let currentTheme: Theme = "light";

function readInitial(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "light";
}

function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (t === "light") root.classList.add("light");
  else root.classList.remove("light");
  const color = t === "light" ? "#fbf3e3" : "#150a2c";
  let meta = document.querySelector(
    'meta[name="theme-color"]',
  ) as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = color;
  root.style.colorScheme = t === "light" ? "light" : "dark";
  syncNativeStatusBar(t);
}

// App Android: ícones da barra de status acompanham o tema (escuros no claro).
function syncNativeStatusBar(t: Theme) {
  if (!isNativePlatform()) return;
  void import("@capacitor/status-bar")
    .then(({ StatusBar, Style }) =>
      StatusBar.setStyle({ style: t === "light" ? Style.Light : Style.Dark }),
    )
    .catch(() => {});
}

function setThemeGlobal(t: Theme) {
  currentTheme = t;
  applyTheme(t);
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {}
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Theme {
  return currentTheme;
}
function getServerSnapshot(): Theme {
  return "light";
}

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
