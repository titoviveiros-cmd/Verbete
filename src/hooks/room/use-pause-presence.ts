import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  ACTIVE_THROTTLE_MS,
  sendAwayBeacon,
  touchPresence,
} from "@/lib/presence";

// Liga a presença do jogador à pausa de partida (ver lib/presence.ts): toque
// no app e volta à tela = 'active'; app fora da tela = 'away'. Só com a
// partida em andamento e para humano ativo da mesa.
export function usePausePresence(opts: {
  roomId: string | undefined;
  playerId: string | undefined;
  inGame: boolean;
  activeHuman: boolean;
}) {
  const { roomId, playerId, inGame, activeHuman } = opts;
  const lastSentRef = useRef(0);
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!roomId || !playerId || !inGame || !activeHuman) return;
    if (typeof document === "undefined") return;
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (alive) tokenRef.current = data.session?.access_token ?? null;
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      tokenRef.current = session?.access_token ?? null;
    });

    const active = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSentRef.current < ACTIVE_THROTTLE_MS) return;
      lastSentRef.current = now;
      void touchPresence(roomId, playerId, "active");
    };
    const away = () => {
      lastSentRef.current = 0; // a próxima volta manda 'active' na hora
      sendAwayBeacon(roomId, playerId, tokenRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") active(true);
      else away();
    };
    const onInteract = () => active();

    if (document.visibilityState === "visible") active(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", away);
    const opts = { capture: true, passive: true } as const;
    document.addEventListener("pointerdown", onInteract, opts);
    document.addEventListener("keydown", onInteract, opts);
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", away);
      document.removeEventListener("pointerdown", onInteract, opts);
      document.removeEventListener("keydown", onInteract, opts);
    };
  }, [roomId, playerId, inGame, activeHuman]);
}
