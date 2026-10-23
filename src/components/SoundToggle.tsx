import { useEffect, useState } from "react";
import {
  getAudioPrefs,
  setAudioMuted,
  subscribeAudioPrefs,
  primeAudio,
  playUITap,
  type AudioPrefs,
} from "@/lib/sound";

export function SoundToggle({ className = "" }: { className?: string }) {
  // Always start with defaults so SSR and first client render match.
  // Hydration is completed before we read localStorage in the effect below.
  const [prefs, setPrefs] = useState<AudioPrefs>({ muted: false, volume: 0.8 });

  useEffect(() => {
    setPrefs(getAudioPrefs());
    return subscribeAudioPrefs(setPrefs);
  }, []);

  const toggle = () => {
    const next = !prefs.muted;
    setAudioMuted(next);
    if (!next) {
      void primeAudio().then(() => playUITap());
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={prefs.muted ? "Ativar som" : "Silenciar som"}
      aria-pressed={prefs.muted}
      className={
        "glass-tile w-8 h-8 max-[380px]:w-[30px] max-[380px]:h-[30px] sm:w-9 sm:h-9 rounded-full " +
        "flex items-center justify-center text-base active:translate-y-px transition " +
        className
      }
    >
      <span aria-hidden>{prefs.muted ? "🔇" : "🔊"}</span>
    </button>
  );
}
