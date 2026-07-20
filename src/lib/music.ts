// Verbete — Dynamic music engine (Web Audio sintetizado, zero assets).
//
// Trilha em camadas: pad harmônico + arpejo. O "mood" controla
// densidade, registro e timbre. Crossfade suave entre moods.
//
// Moods:
//  - silent:  nada tocando
//  - lobby:   pad alegre + arpejo lento (espera amistosa)
//  - tension: pad menor + pulso baixo (escrita/votação)
//  - reveal:  drone curto sustentado (overlay durante revelação)
//  - victory: arpejo maior brilhante (curto, ~6s)

import {
  getAudioPrefs,
  registerMusicDuck,
  subscribeAudioPrefs,
} from "@/lib/sound";

export type Mood = "silent" | "lobby" | "tension" | "reveal" | "victory";

let ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as
      typeof AudioContext | undefined;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  return ctx;
}

// Bus master da música — pub no destino, atenuado pelo mute global.
let masterGain: GainNode | null = null;
let currentMood: Mood = "silent";
let cleanupCurrent: (() => void) | null = null;
let subscribed = false;
let resumeHooked = false;

// Playtest mobile: ao trocar de app, o iOS "interrompe" o AudioContext e mata
// osciladores/schedulers — a música não voltava sozinha. Na retomada da aba,
// religa o contexto e re-arma o loop do mood atual.
function resumeMusicAfterSuspend() {
  const c = ctx;
  if (!c) return;
  if (c.state === "running") return; // nada foi suspenso — não mexe
  try {
    void c.resume();
  } catch {}
  if (currentMood === "lobby" || currentMood === "tension") {
    const prev = cleanupCurrent;
    cleanupCurrent = startMood(currentMood);
    if (prev) setTimeout(prev, 100);
  }
}

const MOOD_BASE_GAIN = 0.18; // baixo, para não competir com SFX

function ensureMaster(c: AudioContext) {
  if (!masterGain) {
    masterGain = c.createGain();
    masterGain.gain.value = getAudioPrefs().muted ? 0 : MOOD_BASE_GAIN;
    masterGain.connect(c.destination);
  }
  if (!resumeHooked && typeof document !== "undefined") {
    resumeHooked = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resumeMusicAfterSuspend();
    });
    window.addEventListener("pageshow", resumeMusicAfterSuspend);
  }
  if (!subscribed) {
    subscribed = true;
    subscribeAudioPrefs((p) => {
      if (!masterGain) return;
      const now = ctx?.currentTime ?? 0;
      const target = p.muted ? 0 : MOOD_BASE_GAIN;
      try {
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.linearRampToValueAtTime(target, now + 0.25);
      } catch {}
    });
    // Registra função de ducking — sound.ts pode pedir para abaixar a música
    // durante SFX importantes (impacto, fanfarra, stinger).
    registerMusicDuck((depth, holdMs) => {
      if (!masterGain || !ctx) return;
      if (getAudioPrefs().muted) return;
      const t = ctx.currentTime;
      const base = MOOD_BASE_GAIN;
      const target = Math.max(0.0001, base * depth);
      try {
        masterGain.gain.cancelScheduledValues(t);
        masterGain.gain.setValueAtTime(masterGain.gain.value, t);
        masterGain.gain.linearRampToValueAtTime(target, t + 0.05);
        masterGain.gain.linearRampToValueAtTime(
          base,
          t + 0.05 + holdMs / 1000 + 0.25,
        );
      } catch {}
    });
  }
  return masterGain;
}

// Escalas (semitons → frequência base C4=261.63)
const C4 = 261.63;
function nf(semis: number) {
  return C4 * Math.pow(2, semis / 12);
}

// Padrões por mood: notas (semis relativos a C4) e timbres.
interface MoodPattern {
  pad: number[]; // acorde sustentado (semis)
  padType: OscillatorType;
  arpeggio: number[]; // sequência (semis)
  arpType: OscillatorType;
  arpStep: number; // segundos entre notas
  arpGain: number;
  padGain: number;
  filterFreq: number;
  /** Kick rítmico em BPM (lobby). 0 = sem kick. */
  kickBpm?: number;
  kickGain?: number;
  /** Heartbeat acelerando (tension). [bpmInicial, bpmFinal, segundosParaAcelerar]. */
  heartbeat?: {
    bpmStart: number;
    bpmEnd: number;
    rampSec: number;
    gain: number;
  };
}

const MOODS: Record<Exclude<Mood, "silent">, MoodPattern> = {
  lobby: {
    // C maior 7 — alegre, espaçoso
    pad: [0, 4, 7, 11, 14],
    padType: "sine",
    arpeggio: [12, 16, 19, 23, 19, 16],
    arpType: "triangle",
    arpStep: 0.42,
    arpGain: 0.12,
    padGain: 0.16,
    filterFreq: 1800,
    kickBpm: 90,
    kickGain: 0.18,
  },
  tension: {
    // D menor 9 (tenso, contemplativo)
    pad: [2, 5, 9, 12, 16],
    padType: "sawtooth",
    arpeggio: [2, 9, 14, 9],
    arpType: "sine",
    arpStep: 0.55,
    arpGain: 0.08,
    padGain: 0.1, // pad mais quieto, sawtooth precisa de filtro
    filterFreq: 700,
    heartbeat: { bpmStart: 70, bpmEnd: 130, rampSec: 28, gain: 0.22 },
  },
  reveal: {
    // Drone D maior aberto — anuncia momento
    pad: [2, 9, 14, 18],
    padType: "triangle",
    arpeggio: [],
    arpType: "sine",
    arpStep: 1,
    arpGain: 0,
    padGain: 0.22,
    filterFreq: 2400,
  },
  victory: {
    // C maior brilhante
    pad: [0, 4, 7, 12, 16, 19],
    padType: "triangle",
    arpeggio: [12, 16, 19, 24, 19, 16],
    arpType: "triangle",
    arpStep: 0.18,
    arpGain: 0.2,
    padGain: 0.22,
    filterFreq: 3200,
  },
};

function startMood(mood: Exclude<Mood, "silent">): () => void {
  const c = getCtx();
  if (!c) return () => {};
  const master = ensureMaster(c);
  const pattern = MOODS[mood];
  const now = c.currentTime;

  // Sub-bus do mood com fade-in
  const moodGain = c.createGain();
  moodGain.gain.setValueAtTime(0.0001, now);
  moodGain.gain.exponentialRampToValueAtTime(1, now + 1.2);
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = pattern.filterFreq;
  filter.Q.value = 0.5;
  moodGain.connect(filter).connect(master);

  // Pad sustentado
  const padOscs: OscillatorNode[] = [];
  for (const semis of pattern.pad) {
    const osc = c.createOscillator();
    osc.type = pattern.padType;
    osc.frequency.value = nf(semis - 12); // uma oitava abaixo p/ pad ficar grave
    osc.detune.value = (Math.random() * 2 - 1) * 6;
    const g = c.createGain();
    g.gain.value = pattern.padGain / pattern.pad.length;
    osc.connect(g).connect(moodGain);
    osc.start(now);
    padOscs.push(osc);
  }

  // LFO sutil no filtro (movimento)
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.12;
  const lfoGain = c.createGain();
  lfoGain.gain.value = pattern.filterFreq * 0.18;
  lfo.connect(lfoGain).connect(filter.frequency);
  lfo.start(now);

  // Arpejo via scheduler em setInterval (suficiente para esses BPMs lentos)
  let stopped = false;
  let arpIdx = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  if (pattern.arpeggio.length > 0) {
    intervalId = setInterval(() => {
      if (stopped || !ctx) return;
      const t = ctx.currentTime;
      const semis = pattern.arpeggio[arpIdx % pattern.arpeggio.length];
      arpIdx++;
      const osc = ctx.createOscillator();
      osc.type = pattern.arpType;
      osc.frequency.value = nf(semis);
      const g = ctx.createGain();
      const peak = pattern.arpGain;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + pattern.arpStep * 0.95);
      osc.connect(g).connect(moodGain);
      osc.start(t);
      osc.stop(t + pattern.arpStep);
    }, pattern.arpStep * 1000);
  }

  // Kick groove (lobby) — pulso 4/4 simples, conecta direto no master (bypass filtro)
  // para preservar o ataque grave.
  let kickIntervalId: ReturnType<typeof setInterval> | null = null;
  if (pattern.kickBpm && pattern.kickGain) {
    const periodMs = 60_000 / pattern.kickBpm;
    const fireKick = () => {
      if (stopped || !ctx) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.1);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(pattern.kickGain!, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.22);
    };
    fireKick();
    kickIntervalId = setInterval(fireKick, periodMs);
  }

  // Heartbeat acelerando (tension) — pulso grave duplo "lub-dub" que acelera.
  let heartbeatTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const heartbeatStartedAt = c.currentTime;
  if (pattern.heartbeat) {
    const hb = pattern.heartbeat;
    const scheduleHeartbeat = () => {
      if (stopped || !ctx) return;
      const t = ctx.currentTime;
      const elapsed = t - heartbeatStartedAt;
      const progress = Math.max(0, Math.min(1, elapsed / hb.rampSec));
      const bpm = hb.bpmStart + (hb.bpmEnd - hb.bpmStart) * progress;
      const periodSec = 60 / bpm;
      // Detune progressivo: até +18 cents no fim — tensão psicológica sutil
      // sem virar caricatura. Ouvido sente "sobe um pouco", não identifica.
      const detuneMul = Math.pow(2, (progress * 18) / 1200);
      // Gain também cresce levemente (até +15%) — coração "batendo mais forte"
      const gainMul = 1 + progress * 0.15;
      // "lub" + "dub"
      for (const [offset, gain] of [
        [0, 1],
        [0.14, 0.7],
      ] as const) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(85 * detuneMul, t + offset);
        osc.frequency.exponentialRampToValueAtTime(
          38 * detuneMul,
          t + offset + 0.1,
        );
        g.gain.setValueAtTime(0.0001, t + offset);
        g.gain.exponentialRampToValueAtTime(
          hb.gain * gain * gainMul,
          t + offset + 0.005,
        );
        g.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.18);
        osc.connect(g).connect(master);
        osc.start(t + offset);
        osc.stop(t + offset + 0.22);
      }
      heartbeatTimeoutId = setTimeout(scheduleHeartbeat, periodSec * 1000);
    };
    scheduleHeartbeat();
  }

  return () => {
    if (stopped) return;
    stopped = true;
    if (intervalId) clearInterval(intervalId);
    if (kickIntervalId) clearInterval(kickIntervalId);
    if (heartbeatTimeoutId) clearTimeout(heartbeatTimeoutId);
    if (!ctx) return;
    const t = ctx.currentTime;
    // Fade-out suave
    try {
      moodGain.gain.cancelScheduledValues(t);
      moodGain.gain.setValueAtTime(moodGain.gain.value, t);
      moodGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    } catch {}
    setTimeout(() => {
      padOscs.forEach((o) => {
        try {
          o.stop();
          o.disconnect();
        } catch {}
      });
      try {
        lfo.stop();
        lfo.disconnect();
      } catch {}
      try {
        moodGain.disconnect();
        filter.disconnect();
      } catch {}
    }, 1200);
  };
}

/** Define o mood atual. Faz crossfade com o anterior. */
export function setMusicMood(mood: Mood) {
  if (typeof window === "undefined") return;
  if (mood === currentMood) return;
  currentMood = mood;
  const prevCleanup = cleanupCurrent;
  cleanupCurrent = null;
  if (mood !== "silent") {
    // pequeno delay para sobrepor brevemente (crossfade real)
    cleanupCurrent = startMood(mood);
  }
  if (prevCleanup) {
    // crossfade longo (600ms de sobreposição) — transição lobby↔tension fica
    // imperceptível em vez de "cortada"
    setTimeout(prevCleanup, 600);
  }
  // Auto-stop curto para reveal/victory (são acentos, não loops)
  if (mood === "reveal") {
    setTimeout(() => {
      if (currentMood === "reveal") setMusicMood("silent");
    }, 2800);
  } else if (mood === "victory") {
    setTimeout(() => {
      if (currentMood === "victory") setMusicMood("silent");
    }, 6500);
  }
}

export function getMusicMood(): Mood {
  return currentMood;
}

/** Para tudo (ex.: ao sair da sala). */
export function stopMusic() {
  setMusicMood("silent");
}
