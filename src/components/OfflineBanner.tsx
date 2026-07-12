import { useEffect, useState } from "react";

/**
 * Banner global mostrando estado offline.
 * - Aparece em ~1s se `navigator.onLine === false`.
 * - Some assim que volta online, com 1.2s mostrando "Reconectado".
 * - Posicionado no topo respeitando safe-area do notch.
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  const [showReconnected, setShowReconnected] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setOnline(navigator.onLine);
    const goOnline = () => {
      setOnline(true);
      setShowReconnected(true);
      setTimeout(() => setShowReconnected(false), 1200);
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online && !showReconnected) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "fixed left-0 right-0 z-[9999] pointer-events-none flex justify-center " +
        "top-[max(0.5rem,env(safe-area-inset-top))]"
      }
    >
      <div
        className={
          "pointer-events-auto rounded-full px-4 py-2 text-sm font-display shadow-pop border border-white/20 " +
          (online
            ? "bg-mint text-accent-foreground"
            : "bg-destructive text-destructive-foreground")
        }
      >
        {online ? "✅ Reconectado" : "📡 Sem conexão — tentando reconectar..."}
      </div>
    </div>
  );
}


