import { motion, AnimatePresence } from "framer-motion";
import { memo, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { sendReaction } from "@/lib/room";
import { playEmojiReaction, playCrowdAah, playCrowdOoh } from "@/lib/sound";

// Curadoria curta: provocações + risadas, ordem do mais usado pro mais raro.
// Tudo visível de uma vez para envio em UM toque.
const EMOJIS = ["😂", "💀", "🔥", "👏", "🤯", "🤥", "🎉", "👀"];
const COOLDOWN_MS = 500;

interface Floater {
  id: string;
  emoji: string;
  x: number;
}

// Hash simples para variar pitch por emoji.
const emojiSeed = (e: string) => {
  let s = 0;
  for (let i = 0; i < e.length; i++) s = (s * 31 + e.charCodeAt(i)) | 0;
  return s;
};

export const ReactionsLayer = memo(function ReactionsLayer({
  roomId,
  playerId,
}: {
  roomId: string;
  playerId: string;
}) {
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [bursting, setBursting] = useState<string | null>(null);
  const lastSent = useRef<number>(0);
  // Throttle de áudio quando vários emojis chegam em rajada.
  const lastAudioAt = useRef<number>(0);
  // Janela deslizante para detectar "crowd reaction": 4+ emojis em 1.2s dispara um "aaah".
  const recentTimestamps = useRef<number[]>([]);
  const lastCrowdAt = useRef<number>(0);
  const reducedMotion = useRef<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      reducedMotion.current = mq.matches;
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  useEffect(() => {
    if (!roomId) return;
    const ch = supabase
      .channel(`reactions:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "reactions",
          filter: `room_id=eq.${roomId}`,
        },
        (p) => {
          const r = p.new as { id: string; emoji: string; player_id?: string };
          if (!reducedMotion.current) {
            const f: Floater = {
              id: r.id,
              emoji: r.emoji,
              x: 5 + Math.random() * 90,
            };
            setFloaters((cur) => [...cur, f]);
            setTimeout(
              () => setFloaters((cur) => cur.filter((x) => x.id !== f.id)),
              3000,
            );
          }
          // Áudio só para reações de OUTROS, com throttle de 180ms (evita máquina de pinball).
          const isMine = r.player_id === playerId;
          const now = Date.now();
          if (!isMine && now - lastAudioAt.current > 180) {
            lastAudioAt.current = now;
            void playEmojiReaction(emojiSeed(r.emoji));
          }
          // Detector de crowd reaction: janela de 1.2s.
          recentTimestamps.current.push(now);
          recentTimestamps.current = recentTimestamps.current.filter(
            (t) => now - t < 1200,
          );
          if (
            recentTimestamps.current.length >= 4 &&
            now - lastCrowdAt.current > 2500
          ) {
            lastCrowdAt.current = now;
            // Alterna entre Aah e Ooh para variar
            void (Math.random() > 0.5 ? playCrowdAah() : playCrowdOoh());
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [roomId, playerId]);

  const send = (emoji: string) => {
    const now = Date.now();
    if (now - lastSent.current < COOLDOWN_MS) return;
    lastSent.current = now;
    setBursting(emoji);
    setTimeout(() => setBursting(null), 350);
    // Feedback imediato no gesto (não esperar realtime).
    if (now - lastAudioAt.current > 120) {
      lastAudioAt.current = now;
      void playEmojiReaction(emojiSeed(emoji));
    }
    try {
      navigator.vibrate?.(15);
    } catch {}
    sendReaction(roomId, playerId, emoji).catch(() => {});
  };

  return (
    <>
      {/* Camada de emojis flutuantes — não-interativa */}
      <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden">
        <AnimatePresence>
          {floaters.map((f) => (
            <motion.div
              key={f.id}
              initial={{ y: 80, opacity: 0, scale: 0.6 }}
              animate={{
                y: -window.innerHeight * 0.7,
                opacity: [0, 1, 1, 0],
                scale: [0.6, 1.4, 1.2, 0.9],
              }}
              exit={{ opacity: 0 }}
              transition={{ duration: 3, ease: "easeOut" }}
              className="absolute text-4xl"
              style={{ left: `${f.x}%`, bottom: 100 }}
            >
              {f.emoji}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Barra de reações COMPACTA (playtest 2026-10-20): acessório, não
          peça principal. Mora na faixa que o .room-shell reserva no rodapé
          (--dock-h), então nunca cobre conteúdo — o ▾ de esconder saiu (só
          existia porque a barra antiga e o 💬 flutuavam sobre as cartas). */}
      <div
        className="fixed left-0 right-0 z-50 pointer-events-none"
        style={{
          bottom: "calc(env(safe-area-inset-bottom, 0px) + 4px)",
          paddingLeft: "max(1rem, env(safe-area-inset-left, 0px))",
          paddingRight: "max(1rem, env(safe-area-inset-right, 0px))",
        }}
      >
        <div className="pointer-events-auto glass-tile mx-auto max-w-[23rem] !bg-[var(--c-surface)]/80 rounded-full p-1 flex items-center justify-between gap-0.5">
          {EMOJIS.map((e) => (
            <motion.button
              key={e}
              whileTap={{ scale: 0.8 }}
              onClick={() => send(e)}
              className="flex-1 min-w-0 h-9 rounded-full hover:bg-white/10 active:bg-white/20 flex items-center justify-center transition-colors"
              aria-label={`Enviar ${e}`}
            >
              <motion.span
                className="text-xl leading-none"
                animate={
                  bursting === e
                    ? { scale: [1, 1.7, 1], rotate: [0, -10, 10, 0] }
                    : {}
                }
                transition={{ duration: 0.35 }}
              >
                {e}
              </motion.span>
            </motion.button>
          ))}
        </div>
      </div>
    </>
  );
});
