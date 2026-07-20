// Verbete — Sound system (Phase 1)
// - Web Audio API procedural sounds (zero assets, zero network).
// - Master mute + volume persistido em localStorage com pub/sub.
// - Buses (sfx/ui/music) com ganho independente e ducking de música.
// - Fallback WAV em base64 para destravar autoplay em iOS Safari.

type Bus = "sfx" | "ui" | "music";
type Listener = (s: AudioPrefs) => void;

export interface AudioPrefs {
  muted: boolean;
  volume: number; // 0..1 master
}

const STORAGE_KEY = "verbete:audio:v1";
const DEFAULT_PREFS: AudioPrefs = { muted: false, volume: 0.8 };

let prefs: AudioPrefs = loadPrefs();
const listeners = new Set<Listener>();

function loadPrefs(): AudioPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_PREFS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      muted:
        typeof parsed.muted === "boolean" ? parsed.muted : DEFAULT_PREFS.muted,
      volume:
        typeof parsed.volume === "number"
          ? Math.max(0, Math.min(1, parsed.volume))
          : DEFAULT_PREFS.volume,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs() {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
}

export function getAudioPrefs(): AudioPrefs {
  return { ...prefs };
}

export function setAudioMuted(muted: boolean) {
  prefs = { ...prefs, muted };
  savePrefs();
  listeners.forEach((l) => l(prefs));
}

export function setAudioVolume(volume: number) {
  prefs = { ...prefs, volume: Math.max(0, Math.min(1, volume)) };
  savePrefs();
  listeners.forEach((l) => l(prefs));
}

export function subscribeAudioPrefs(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// Per-bus relative weights (multiplied by master volume).
// Pesos reduzidos globalmente (~35%) para um mix mais suave e agradável,
// preservando a hierarquia entre sfx > ui > music.
const BUS_WEIGHTS: Record<Bus, number> = { sfx: 0.65, ui: 0.36, music: 0.32 };

function busGain(bus: Bus) {
  if (prefs.muted) return 0;
  return prefs.volume * BUS_WEIGHTS[bus];
}

// ============================================================
// AudioContext + autoplay unlock (mantém comportamento do V1)
// ============================================================
let ctx: AudioContext | null = null;
let unlocked = false;
let installed = false;
let fallbackUnlocked = false;
type FallbackKind = "alert" | "join" | "tick";
const fallbackEls: Partial<Record<FallbackKind, HTMLAudioElement>> = {};

type ToneNote = { freq: number; start: number; dur: number; gain: number };

const FALLBACK_NOTES: Record<FallbackKind, ToneNote[]> = {
  alert: [
    { freq: 880, start: 0, dur: 0.18, gain: 0.55 },
    { freq: 1320, start: 0.16, dur: 0.28, gain: 0.55 },
  ],
  join: [
    { freq: 523.25, start: 0, dur: 0.16, gain: 0.5 },
    { freq: 659.25, start: 0.1, dur: 0.16, gain: 0.5 },
    { freq: 783.99, start: 0.2, dur: 0.3, gain: 0.5 },
  ],
  tick: [{ freq: 1046.5, start: 0, dur: 0.08, gain: 0.5 }],
};

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

async function ensureRunning(): Promise<AudioContext | null> {
  const c = getCtx();
  if (!c) return null;
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {}
  }
  return c.state === "running" ? c : null;
}

function warmVibrate() {
  if (typeof navigator === "undefined") return;
  try {
    navigator.vibrate?.(1);
  } catch {}
}

function playSilentBuffer(c: AudioContext) {
  if (c.state !== "running") return;
  try {
    const buf = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
  } catch {}
}

function toneDataUri(notes: ToneNote[]) {
  const sampleRate = 16000;
  const totalDuration = Math.max(...notes.map((n) => n.start + n.dur)) + 0.08;
  const sampleCount = Math.ceil(totalDuration * sampleRate);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    let mixed = 0;
    for (const n of notes) {
      if (t < n.start || t > n.start + n.dur) continue;
      const local = t - n.start;
      const fade = Math.min(1, local / 0.02, (n.dur - local) / 0.04);
      mixed +=
        Math.sin(2 * Math.PI * n.freq * local) * n.gain * Math.max(0, fade);
    }
    samples[i] = Math.max(-32767, Math.min(32767, Math.round(mixed * 32767)));
  }
  const bytes = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++)
      view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.byteLength, true);
  bytes.set(new Uint8Array(samples.buffer), 44);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function getFallback(kind: FallbackKind) {
  if (typeof window === "undefined") return null;
  if (!fallbackEls[kind]) {
    const el = new Audio(toneDataUri(FALLBACK_NOTES[kind]));
    el.preload = "auto";
    el.volume = 0.65;
    (el as any).playsInline = true;
    fallbackEls[kind] = el;
  }
  return fallbackEls[kind] ?? null;
}

async function unlockFallbackAudio() {
  if (fallbackUnlocked) return;
  const els = [getFallback("alert"), getFallback("join")].filter(
    (el): el is HTMLAudioElement => !!el,
  );
  await Promise.all(
    els.map(async (el) => {
      const prev = el.volume;
      try {
        el.muted = false;
        el.volume = 0.01;
        await el.play();
        el.pause();
        el.currentTime = 0;
        fallbackUnlocked = true;
      } catch {
      } finally {
        el.muted = false;
        el.volume = prev || 0.65;
      }
    }),
  );
}

async function playFallback(kind: FallbackKind) {
  if (prefs.muted) return;
  const el = getFallback(kind);
  if (!el) return;
  try {
    el.pause();
    el.currentTime = 0;
    el.muted = false;
    el.volume = Math.max(0.05, prefs.volume * 0.7);
    await el.play();
  } catch {}
}

export function installAudioUnlock() {
  if (typeof window === "undefined" || installed) return;
  installed = true;
  const unlock = () => {
    void primeAudio();
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  window.addEventListener("touchstart", unlock, { passive: true });
  window.addEventListener("click", unlock);
  const onVisible = () => {
    if (document.visibilityState === "visible") void primeAudio();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
}

export async function primeAudio() {
  const c = getCtx();
  const fb = unlockFallbackAudio();
  if (c) {
    if (c.state === "suspended") {
      try {
        await c.resume();
      } catch {}
    }
    if (c.state === "running") {
      if (!unlocked) playSilentBuffer(c);
      unlocked = true;
    }
  }
  await fb;
  warmVibrate();
}

export function vibrate(pattern: number | number[] = [120, 60, 120]) {
  if (typeof navigator === "undefined") return;
  if (prefs.muted) return; // respeita o mute global também para vibração
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}

// ============================================================
// Master bus + reverb (espacialização global — "vida" no áudio)
// ============================================================
let masterNode: GainNode | null = null;
let reverbSend: GainNode | null = null;

function makeImpulse(
  c: AudioContext,
  duration = 1.4,
  decay = 2.6,
): AudioBuffer {
  const rate = c.sampleRate;
  const len = Math.max(1, Math.floor(rate * duration));
  const buf = c.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function makeSaturationCurve(amount = 0.35): Float32Array {
  // Curva de saturação suave (tanh-like) — "fatness" sem distorção agressiva.
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount * 80;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function getMaster(c: AudioContext): GainNode {
  if (masterNode) return masterNode;
  const m = c.createGain();
  m.gain.value = 1;
  // Cadeia de masterização: input → highpass (limpa subgraves) → saturação
  // leve → compressor (cola dinâmica) → reverb send → destino
  try {
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 70; // remove rumble inaudível que embaça o mix
    hp.Q.value = 0.5;

    const shaper = c.createWaveShaper();
    // Saturação mais leve — menos "punch", mais limpo aos ouvidos.
    shaper.curve = makeSaturationCurve(0.14) as any;
    shaper.oversample = "2x";

    const comp = c.createDynamicsCompressor();
    // Compressão mais gentil e com release maior — evita "bombeamento" e dureza.
    comp.threshold.value = -22;
    comp.knee.value = 16;
    comp.ratio.value = 2.2;
    comp.attack.value = 0.012;
    comp.release.value = 0.28;

    const postGain = c.createGain();
    postGain.gain.value = 0.78; // atenuação geral pós-compressão (suaviza tudo)
    m.connect(hp)
      .connect(shaper)
      .connect(comp)
      .connect(postGain)
      .connect(c.destination);

    const convolver = c.createConvolver();
    convolver.buffer = makeImpulse(c);
    const send = c.createGain();
    send.gain.value = 0.12; // wet ainda mais sutil
    const wetOut = c.createGain();
    wetOut.gain.value = 0.7;
    m.connect(send).connect(convolver).connect(wetOut).connect(c.destination);
    reverbSend = send;
  } catch {
    m.connect(c.destination);
  }
  masterNode = m;
  return m;
}

/** Cria um nó de pan estéreo aleatório (subtle ±0.35) para enriquecer o mix. */
function createSubtlePanner(
  c: AudioContext,
  bias = 0,
): StereoPannerNode | null {
  try {
    const p = c.createStereoPanner();
    p.pan.value = Math.max(
      -1,
      Math.min(1, bias + (Math.random() * 2 - 1) * 0.35),
    );
    return p;
  } catch {
    return null;
  }
}

// ============================================================
// Engine de tons (com bus, envelope, variação e ducking)
// ============================================================
type Tone = {
  freq: number;
  start: number;
  dur: number;
  gain: number;
  type: OscillatorType;
  /** Glide opcional para esta nota (Hz no fim da duração). */
  glideTo?: number;
};

// Ducking de música — `music.ts` registra um callback que efetivamente abaixa o
// seu próprio bus (cada um tem AudioContext próprio, então não dá pra compartilhar nodes).
type DuckFn = (depth: number, holdMs: number) => void;
let musicDuckCallback: DuckFn | null = null;
let lastDuckAt = 0;
export function registerMusicDuck(fn: DuckFn | null) {
  musicDuckCallback = fn;
}

function duckMusic(_c: AudioContext, depth = 0.35, holdMs = 200) {
  if (!musicDuckCallback) return;
  // Throttle: evita 10 ducks empilhados quando vários tones disparam juntos.
  const now = Date.now();
  if (now - lastDuckAt < 30) return;
  lastDuckAt = now;
  try {
    musicDuckCallback(depth, holdMs);
  } catch {}
}

function scheduleTones(
  c: AudioContext,
  bus: Bus,
  notes: Tone[],
  opts?: { jitterCents?: number; duck?: boolean },
) {
  const gMaster = busGain(bus);
  if (gMaster <= 0) return;
  const now = c.currentTime + 0.02;
  const jitter = opts?.jitterCents ?? 0;
  const out = getMaster(c);
  for (const n of notes) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = n.type;
    const detune = jitter ? (Math.random() * 2 - 1) * jitter : 0;
    osc.frequency.setValueAtTime(n.freq, now + n.start);
    if (n.glideTo) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, n.glideTo),
        now + n.start + n.dur,
      );
    }
    if (detune) osc.detune.setValueAtTime(detune, now + n.start);
    const peak = Math.max(0.0001, n.gain * gMaster);
    g.gain.setValueAtTime(0.0001, now + n.start);
    g.gain.exponentialRampToValueAtTime(peak, now + n.start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);
    osc.connect(g).connect(out);
    osc.start(now + n.start);
    osc.stop(now + n.start + n.dur + 0.05);
  }
  if (opts?.duck) duckMusic(c);
}

async function play(
  bus: Bus,
  notes: Tone[],
  opts?: {
    vibrate?: number | number[];
    jitterCents?: number;
    duck?: boolean;
    fallback?: FallbackKind;
  },
) {
  if (prefs.muted) return;
  if (opts?.vibrate) vibrate(opts.vibrate);
  const c = await ensureRunning();
  if (c) {
    scheduleTones(c, bus, notes, opts);
    return;
  }
  if (opts?.fallback) await playFallback(opts.fallback);
}

// ============================================================
// SFX públicos
// ============================================================

/** Entrada de jogador — campainha cordial em quinta + oitava (G5–D6–G6). */
export async function playJoin() {
  await play(
    "sfx",
    [
      { freq: 783.99, start: 0.0, dur: 0.16, gain: 0.2, type: "sine" }, // G5
      { freq: 1174.66, start: 0.08, dur: 0.2, gain: 0.2, type: "sine" }, // D6
      { freq: 1567.98, start: 0.18, dur: 0.36, gain: 0.18, type: "triangle" }, // G6
      { freq: 3135.96, start: 0.2, dur: 0.18, gain: 0.06, type: "sine" }, // brilho harmônico
    ],
    { vibrate: [30, 30, 30], jitterCents: 6, fallback: "join" },
  );
}

/** Bot — sequência digital sintética com glide (lo-fi bleep). */
export async function playBotJoin() {
  await play(
    "sfx",
    [
      {
        freq: 330,
        start: 0.0,
        dur: 0.09,
        gain: 0.2,
        type: "square",
        glideTo: 520,
      },
      {
        freq: 520,
        start: 0.11,
        dur: 0.09,
        gain: 0.2,
        type: "square",
        glideTo: 660,
      },
      { freq: 880, start: 0.22, dur: 0.14, gain: 0.18, type: "square" },
    ],
    { fallback: "join" },
  );
}

/** Jogador saiu — bump grave + slide curto (porta fechando). */
export async function playKick() {
  await play(
    "sfx",
    [
      {
        freq: 520,
        start: 0.0,
        dur: 0.08,
        gain: 0.22,
        type: "sawtooth",
        glideTo: 180,
      },
      {
        freq: 160,
        start: 0.1,
        dur: 0.22,
        gain: 0.2,
        type: "sine",
        glideTo: 90,
      },
    ],
    { vibrate: 80, fallback: "alert" },
  );
}

/** Alerta — duas notas em quarta justa (D6 → G6), brilhante e neutra. */
export async function playAlert() {
  await play(
    "sfx",
    [
      { freq: 1174.66, start: 0.0, dur: 0.16, gain: 0.24, type: "sine" },
      { freq: 1567.98, start: 0.14, dur: 0.3, gain: 0.24, type: "sine" },
      { freq: 2349.32, start: 0.14, dur: 0.2, gain: 0.08, type: "triangle" }, // harmônico
    ],
    { vibrate: [100, 60, 100], jitterCents: 4, fallback: "alert" },
  );
}

/** Confirmação de envio — "tic-pock" curto, terça menor ascendente. */
export async function playSubmit() {
  await play(
    "ui",
    [
      { freq: 740, start: 0.0, dur: 0.06, gain: 0.2, type: "triangle" }, // F#5
      { freq: 880, start: 0.05, dur: 0.1, gain: 0.18, type: "sine" }, // A5
    ],
    { vibrate: 22, jitterCents: 8 },
  );
}

/** Clique UI — micro click sino (mais "tátil" que o anterior). */
export type UITapVariant = "default" | "primary" | "secondary" | "soft";

/** Tap de UI com variantes de hierarquia auditiva.
 *  - default   : tom médio neutro (1760Hz)
 *  - primary   : grave + corpo — botões de ação principal (Confirmar/Avançar)
 *  - secondary : agudo curto — links, toggles, ações secundárias
 *  - soft      : muito discreto — abrir menus, hovers táteis */
export async function playUITap(variant: UITapVariant = "default") {
  const presets: Record<
    UITapVariant,
    { f1: number; f2: number; g1: number; g2: number; dur: number }
  > = {
    default: { f1: 1760, f2: 2637, g1: 0.12, g2: 0.06, dur: 0.03 },
    primary: { f1: 1320, f2: 1980, g1: 0.16, g2: 0.08, dur: 0.05 },
    secondary: { f1: 2349, f2: 3520, g1: 0.1, g2: 0.05, dur: 0.025 },
    soft: { f1: 1568, f2: 2349, g1: 0.06, g2: 0.03, dur: 0.025 },
  };
  const p = presets[variant];
  await play(
    "ui",
    [
      { freq: p.f1, start: 0.0, dur: p.dur, gain: p.g1, type: "triangle" },
      { freq: p.f2, start: 0.01, dur: p.dur + 0.01, gain: p.g2, type: "sine" },
    ],
    { jitterCents: 18 },
  );
}

/** Voto registrado — duplo tique cristalino. */
export async function playVoteCast() {
  // Pizzicato de contrabaixo — ataque seco e curtíssimo, corpo curto,
  // sensação tátil de "carimbo" sem brilho de UI genérica.
  // Sawtooth filtrado (lowpass dinâmico) + ping agudo de oitava acima.
  const c = await ensureRunning();
  if (!c) return;
  const out = getMaster(c);
  const gM = busGain("sfx");
  if (gM <= 0) return;
  vibrate(25);
  const now = c.currentTime + 0.005;

  // Corpo pizzicato: sawtooth grave com filtro lowpass que fecha rápido
  const osc = c.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(196.0, now); // G3 (corda solta)
  osc.detune.value = (Math.random() * 2 - 1) * 8;
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.Q.value = 4;
  filt.frequency.setValueAtTime(2400, now);
  filt.frequency.exponentialRampToValueAtTime(380, now + 0.18);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.3 * gM, now + 0.005); // ataque 5ms
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22); // release 220ms
  osc.connect(filt).connect(g).connect(out);
  osc.start(now);
  osc.stop(now + 0.26);

  // Ping de oitava — micro brilho de "click" da unha na corda
  const ping = c.createOscillator();
  ping.type = "triangle";
  ping.frequency.value = 1568; // G6
  const pg = c.createGain();
  pg.gain.setValueAtTime(0.0001, now);
  pg.gain.exponentialRampToValueAtTime(0.06 * gM, now + 0.003);
  pg.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  ping.connect(pg).connect(out);
  ping.start(now);
  ping.stop(now + 0.1);
}

/** Recebeu voto — sino duplo brilhante (oitava). */
export async function playVoteReceived() {
  await play(
    "sfx",
    [
      { freq: 1396.91, start: 0.0, dur: 0.2, gain: 0.22, type: "sine" }, // F6
      { freq: 2093.0, start: 0.08, dur: 0.28, gain: 0.18, type: "sine" }, // C7
      { freq: 4186.01, start: 0.08, dur: 0.18, gain: 0.05, type: "sine" }, // sparkle
    ],
    { vibrate: 45, jitterCents: 8, duck: true },
  );
}

/** Ganhou pontos — arpejo Fá maior + nota de coroa. */
export async function playPointGained() {
  await play(
    "sfx",
    [
      { freq: 698.46, start: 0.0, dur: 0.09, gain: 0.22, type: "triangle" }, // F5
      { freq: 880.0, start: 0.07, dur: 0.09, gain: 0.22, type: "triangle" }, // A5
      { freq: 1046.5, start: 0.14, dur: 0.09, gain: 0.22, type: "triangle" }, // C6
      { freq: 1396.91, start: 0.21, dur: 0.1, gain: 0.24, type: "triangle" }, // F6
      { freq: 2093.0, start: 0.31, dur: 0.26, gain: 0.18, type: "sine" }, // C7 sustain
    ],
    { vibrate: [30, 30, 80], duck: true },
  );
}

/** Revelação correta — "shimmer chord" Dó maior add9 com glissando. */
export async function playCorrectReveal() {
  await play(
    "sfx",
    [
      // pequeno glissando ascendente
      {
        freq: 392.0,
        start: 0.0,
        dur: 0.18,
        gain: 0.18,
        type: "triangle",
        glideTo: 1046.5,
      },
      // acorde maior add9 sustentado
      { freq: 523.25, start: 0.18, dur: 0.65, gain: 0.18, type: "sine" }, // C5
      { freq: 659.25, start: 0.18, dur: 0.65, gain: 0.16, type: "sine" }, // E5
      { freq: 783.99, start: 0.18, dur: 0.65, gain: 0.16, type: "sine" }, // G5
      { freq: 1174.66, start: 0.18, dur: 0.65, gain: 0.14, type: "sine" }, // D6 (9ª)
      { freq: 2093.0, start: 0.22, dur: 0.55, gain: 0.08, type: "sine" }, // C7 brilho
    ],
    { vibrate: [50, 40, 50, 40, 120], duck: true },
  );
}

/** Vitória de rodada — fanfarra Sol maior em 4 notas + sustain. */
export async function playRoundWin() {
  await play(
    "sfx",
    [
      { freq: 392.0, start: 0.0, dur: 0.13, gain: 0.26, type: "triangle" }, // G4
      { freq: 587.33, start: 0.11, dur: 0.13, gain: 0.26, type: "triangle" }, // D5
      { freq: 783.99, start: 0.22, dur: 0.13, gain: 0.26, type: "triangle" }, // G5
      { freq: 1174.66, start: 0.33, dur: 0.32, gain: 0.28, type: "triangle" }, // D6
      { freq: 1567.98, start: 0.4, dur: 0.3, gain: 0.16, type: "sine" }, // G6 coroa
    ],
    { vibrate: [70, 60, 160], duck: true },
  );
}

/** Vitória final — progressão clássica IV → V → I em Ré maior (G → A → D),
 *  cada acorde com sua cor harmônica, resolvendo no acorde D maior add9 sustentado.
 *  É a cadência mais reconhecida da música ocidental: "fim épico". */
export async function playGameWin() {
  await play(
    "sfx",
    [
      // === IV: Sol maior (G-B-D) — 0.00s, 220ms — abertura cheia ===
      { freq: 196.0, start: 0.0, dur: 0.28, gain: 0.18, type: "triangle" }, // G3
      { freq: 392.0, start: 0.0, dur: 0.28, gain: 0.2, type: "triangle" }, // G4
      { freq: 493.88, start: 0.0, dur: 0.28, gain: 0.18, type: "triangle" }, // B4
      { freq: 587.33, start: 0.0, dur: 0.28, gain: 0.16, type: "sine" }, // D5
      // === V: Lá maior (A-C#-E) — 0.30s, 220ms — tensão dominante ===
      { freq: 220.0, start: 0.3, dur: 0.28, gain: 0.18, type: "triangle" }, // A3
      { freq: 440.0, start: 0.3, dur: 0.28, gain: 0.2, type: "triangle" }, // A4
      { freq: 554.37, start: 0.3, dur: 0.28, gain: 0.18, type: "triangle" }, // C#5
      { freq: 659.25, start: 0.3, dur: 0.28, gain: 0.16, type: "sine" }, // E5
      // === I: Ré maior add9 (D-F#-A-D-E) — 0.62s, sustain 0.95s — resolução ===
      { freq: 146.83, start: 0.62, dur: 1.1, gain: 0.2, type: "triangle" }, // D3 (raiz grave)
      { freq: 293.66, start: 0.62, dur: 1.0, gain: 0.2, type: "sine" }, // D4
      { freq: 369.99, start: 0.62, dur: 1.0, gain: 0.18, type: "sine" }, // F#4
      { freq: 440.0, start: 0.62, dur: 1.0, gain: 0.18, type: "sine" }, // A4
      { freq: 587.33, start: 0.62, dur: 1.0, gain: 0.16, type: "sine" }, // D5
      { freq: 659.25, start: 0.68, dur: 0.95, gain: 0.12, type: "sine" }, // E5 (9ª)
      { freq: 880.0, start: 0.7, dur: 0.9, gain: 0.1, type: "sine" }, // A5 brilho
      { freq: 1174.66, start: 0.74, dur: 0.85, gain: 0.06, type: "sine" }, // D6 coroa
    ],
    { vibrate: [80, 60, 80, 60, 110, 80, 260], duck: true },
  );
}

/** Reação por emoji — duo de marimba curtinho, com pitch que varia. */
export async function playEmojiReaction(seed = 0) {
  const base = 660 + (Math.abs(seed) % 9) * 70; // varia conforme o emoji
  await play(
    "ui",
    [
      { freq: base, start: 0.0, dur: 0.05, gain: 0.18, type: "sine" },
      {
        freq: base * 1.5,
        start: 0.03,
        dur: 0.09,
        gain: 0.16,
        type: "triangle",
      },
      { freq: base * 3, start: 0.03, dur: 0.05, gain: 0.05, type: "sine" }, // brilho
    ],
    { jitterCents: 22 },
  );
}

// ============================================================
// Countdown — escala cromática ascendente nos últimos 5s
// ============================================================
// 5s = G5, 4s = A5, 3s = B5, 2s = C6, 1s = D6 (tensão progressiva)
// 10..6 = ticks suaves; 5..1 = tensão progressiva.
const COUNTDOWN_TICK_FREQS: Record<number, number> = {
  10: 523.25, // C5
  9: 554.37, // C#5
  8: 587.33, // D5
  7: 622.25, // D#5
  6: 698.46, // F5
  5: 783.99, // G5
  4: 880.0, // A5
  3: 987.77, // B5
  2: 1046.5, // C6
  1: 1174.66, // D6
};

/** Tick por segundo — frequência sobe de 5 para 1, criando tensão. */
export async function playCountdownTick(remaining?: number) {
  const r = typeof remaining === "number" ? remaining : 3;
  const freq = COUNTDOWN_TICK_FREQS[r] ?? 1000;
  // Ticks 10..6 são mais suaves; a partir de 5 sobe gradualmente.
  const gain = r > 5 ? 0.14 : 0.22 + (5 - r) * 0.025;
  await play("sfx", [{ freq, start: 0, dur: 0.1, gain, type: "square" }], {
    vibrate: 30,
    duck: true,
    fallback: "tick",
  });
}

/** Buzina final — trítono descendente + nota grave longa (tensão resolvida em peso). */
export async function playCountdownFinal() {
  await play(
    "sfx",
    [
      { freq: 1760, start: 0.0, dur: 0.2, gain: 0.36, type: "sawtooth" }, // A6
      { freq: 1244, start: 0.2, dur: 0.2, gain: 0.36, type: "sawtooth" }, // D#6 (trítono)
      { freq: 880, start: 0.4, dur: 0.2, gain: 0.38, type: "sawtooth" }, // A5
      { freq: 220, start: 0.55, dur: 0.55, gain: 0.42, type: "square" }, // A3 sub
    ],
    { vibrate: [200, 80, 200, 80, 300], duck: true, fallback: "alert" },
  );
}

// ============================================================
// Noise engine — para whooshes, crowd reactions, impactos
// ============================================================
let noiseBufferCache: AudioBuffer | null = null;
function getNoiseBuffer(c: AudioContext): AudioBuffer {
  if (noiseBufferCache && noiseBufferCache.sampleRate === c.sampleRate)
    return noiseBufferCache;
  const len = Math.floor(c.sampleRate * 2);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBufferCache = buf;
  return buf;
}

interface NoiseOpts {
  bus?: Bus;
  duration: number;
  filterType?: BiquadFilterType;
  filterStart: number;
  filterEnd: number;
  q?: number;
  peakGain: number;
  attack?: number;
  release?: number;
  duck?: boolean;
  vibrate?: number | number[];
  /** Pan estéreo fixo (-1..1). Se omitido, mono central. */
  pan?: number;
}

async function playNoise(opts: NoiseOpts) {
  if (prefs.muted) return;
  if (opts.vibrate) vibrate(opts.vibrate);
  const c = await ensureRunning();
  if (!c) return;
  const bus = opts.bus ?? "sfx";
  const gMaster = busGain(bus);
  if (gMaster <= 0) return;
  const now = c.currentTime + 0.01;
  const src = c.createBufferSource();
  src.buffer = getNoiseBuffer(c);
  src.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = opts.filterType ?? "bandpass";
  filter.Q.value = opts.q ?? 1.2;
  filter.frequency.setValueAtTime(opts.filterStart, now);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(20, opts.filterEnd),
    now + opts.duration,
  );
  const g = c.createGain();
  const attack = opts.attack ?? 0.04;
  const release = opts.release ?? 0.18;
  const peak = Math.max(0.0001, opts.peakGain * gMaster);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(peak, now + attack);
  g.gain.setValueAtTime(peak, now + opts.duration - release);
  g.gain.exponentialRampToValueAtTime(0.0001, now + opts.duration);
  // Pan estéreo opcional
  let panner: StereoPannerNode | null = null;
  if (typeof opts.pan === "number") {
    try {
      panner = c.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
    } catch {
      panner = null;
    }
  }
  if (panner) {
    src.connect(filter).connect(g).connect(panner).connect(getMaster(c));
  } else {
    src.connect(filter).connect(g).connect(getMaster(c));
  }
  src.start(now);
  src.stop(now + opts.duration + 0.05);
  if (opts.duck) duckMusic(c, 0.4, opts.duration * 700);
}

/** Whoosh ascendente — transição entre fases. */
export async function playWhooshUp() {
  await playNoise({
    duration: 0.55,
    filterType: "bandpass",
    filterStart: 280,
    filterEnd: 4200,
    q: 1.4,
    peakGain: 0.16,
    attack: 0.06,
    release: 0.25,
    duck: true,
  });
}

/** Whoosh descendente — saída/derrota suave. */
export async function playWhooshDown() {
  await playNoise({
    duration: 0.5,
    filterType: "bandpass",
    filterStart: 3800,
    filterEnd: 220,
    q: 1.4,
    peakGain: 0.28,
    attack: 0.05,
    release: 0.22,
    duck: true,
  });
}

/** Impacto grave — usado antes de revelação grande. */
export async function playImpact() {
  await playNoise({
    duration: 0.45,
    filterType: "lowpass",
    filterStart: 800,
    filterEnd: 80,
    q: 0.9,
    peakGain: 0.55,
    attack: 0.005,
    release: 0.35,
    duck: true,
    vibrate: 60,
  });
}

/** "Aaah" do público — pan aleatório para simular público em volta. */
export async function playCrowdAah() {
  await playNoise({
    duration: 1.1,
    filterType: "bandpass",
    filterStart: 480,
    filterEnd: 720,
    q: 3.5,
    peakGain: 0.22,
    attack: 0.18,
    release: 0.5,
    duck: true,
    pan: (Math.random() * 2 - 1) * 0.55, // -0.55..+0.55 (não 100% lateral)
  });
}

/** "Ooh" do público — pan aleatório (oposto ao Aah se em sequência). */
export async function playCrowdOoh() {
  await playNoise({
    duration: 0.85,
    filterType: "bandpass",
    filterStart: 380,
    filterEnd: 520,
    q: 4.5,
    peakGain: 0.2,
    attack: 0.12,
    release: 0.4,
    duck: true,
    pan: (Math.random() * 2 - 1) * 0.55,
  });
}

/** Stinger cinematográfico — acorde menor com 7ª (suspense moderno). Sem impacto interno:
 *  callers que querem o "thump" devem chamar `playCrash` antes (já feito em `playRevealBuildUp`). */
export async function playRevealStinger() {
  await play(
    "sfx",
    [
      // Acorde Am7 grave (A-C-E-G) — tenso mas elegante
      { freq: 110.0, start: 0.0, dur: 0.95, gain: 0.18, type: "sawtooth" }, // A2
      { freq: 130.81, start: 0.0, dur: 0.95, gain: 0.14, type: "sawtooth" }, // C3
      { freq: 164.81, start: 0.0, dur: 0.95, gain: 0.14, type: "sawtooth" }, // E3
      { freq: 196.0, start: 0.05, dur: 0.85, gain: 0.1, type: "sine" }, // G3
      { freq: 392.0, start: 0.1, dur: 0.78, gain: 0.06, type: "sine" }, // G4 brilho
    ],
    { duck: true },
  );
}

/** Você foi enganado — wah-wah de trombone cômico descendente. */
export async function playFooled() {
  await play(
    "sfx",
    [
      {
        freq: 466.16,
        start: 0.0,
        dur: 0.22,
        gain: 0.24,
        type: "sawtooth",
        glideTo: 369.99,
      }, // Bb4 -> F#4
      {
        freq: 369.99,
        start: 0.22,
        dur: 0.24,
        gain: 0.22,
        type: "sawtooth",
        glideTo: 293.66,
      }, // F#4 -> D4
      {
        freq: 293.66,
        start: 0.46,
        dur: 0.4,
        gain: 0.22,
        type: "triangle",
        glideTo: 220.0,
      }, // D4 -> A3
    ],
    { vibrate: [40, 80, 40], duck: true },
  );
}

/** Você enganou alguém — risadinha brincalhona ascendente. */
export async function playFooledOthers() {
  await play(
    "sfx",
    [
      { freq: 587, start: 0.0, dur: 0.05, gain: 0.18, type: "triangle" },
      { freq: 784, start: 0.05, dur: 0.05, gain: 0.18, type: "triangle" },
      { freq: 698, start: 0.1, dur: 0.05, gain: 0.18, type: "triangle" },
      { freq: 932, start: 0.15, dur: 0.05, gain: 0.18, type: "triangle" },
      { freq: 1047, start: 0.2, dur: 0.06, gain: 0.2, type: "triangle" },
      { freq: 1397, start: 0.26, dur: 0.14, gain: 0.22, type: "triangle" },
      { freq: 2093, start: 0.28, dur: 0.1, gain: 0.06, type: "sine" }, // brilho
    ],
    { vibrate: [30, 30, 30], jitterCents: 18, duck: true },
  );
}

/** Transição genérica entre fases (whoosh + sub-bump curto). */
export async function playPhaseTransition() {
  void playWhooshUp();
}

// ============================================================
// Sprint 1 — Dopamina: build-up + público + tick ambiente
// ============================================================

/** Drumroll cinematográfico — pulsos graves acelerando (tipo "espera, vem coisa boa"). */
export async function playDrumRoll(durationMs = 900) {
  if (prefs.muted) return;
  const c = await ensureRunning();
  if (!c) return;
  const gMaster = busGain("sfx");
  if (gMaster <= 0) return;
  const out = getMaster(c);
  const now = c.currentTime + 0.02;
  const totalSec = durationMs / 1000;

  // Camada 1: pulsos graves acelerando (kick-roll)
  let t = 0;
  let interval = 0.1; // começa lento
  while (t < totalSec) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, now + t);
    osc.frequency.exponentialRampToValueAtTime(45, now + t + 0.09);
    const peak = 0.32 * gMaster * (0.55 + 0.45 * (t / totalSec));
    g.gain.setValueAtTime(0.0001, now + t);
    g.gain.exponentialRampToValueAtTime(peak, now + t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.09);
    osc.connect(g).connect(out);
    osc.start(now + t);
    osc.stop(now + t + 0.11);
    t += interval;
    interval = Math.max(0.025, interval * 0.82); // acelera exponencialmente
  }

  // Camada 2: ruído filtrado tipo redoblante
  const src = c.createBufferSource();
  src.buffer = getNoiseBuffer(c);
  src.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.5;
  filter.frequency.setValueAtTime(1800, now);
  filter.frequency.exponentialRampToValueAtTime(3200, now + totalSec);
  const g = c.createGain();
  const peak = 0.18 * gMaster;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(peak * 0.4, now + 0.08);
  g.gain.linearRampToValueAtTime(peak, now + totalSec - 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, now + totalSec);
  src.connect(filter).connect(g).connect(out);
  src.start(now);
  src.stop(now + totalSec + 0.05);

  duckMusic(c, 0.25, durationMs);
}

/** Riser — varredura ascendente que gera expectativa máxima. */
export async function playRiser(durationMs = 700) {
  if (prefs.muted) return;
  const c = await ensureRunning();
  if (!c) return;
  const gMaster = busGain("sfx");
  if (gMaster <= 0) return;
  const out = getMaster(c);
  const now = c.currentTime + 0.02;
  const totalSec = durationMs / 1000;

  // Tom ascendente
  const osc = c.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.exponentialRampToValueAtTime(1760, now + totalSec);
  const og = c.createGain();
  const opeak = 0.18 * gMaster;
  og.gain.setValueAtTime(0.0001, now);
  og.gain.exponentialRampToValueAtTime(opeak, now + totalSec * 0.6);
  og.gain.exponentialRampToValueAtTime(opeak * 1.4, now + totalSec);
  og.gain.exponentialRampToValueAtTime(0.0001, now + totalSec + 0.08);
  osc.connect(og).connect(out);
  osc.start(now);
  osc.stop(now + totalSec + 0.12);

  // Noise sweep
  const src = c.createBufferSource();
  src.buffer = getNoiseBuffer(c);
  src.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.setValueAtTime(400, now);
  filter.frequency.exponentialRampToValueAtTime(4500, now + totalSec);
  filter.Q.value = 0.8;
  const ng = c.createGain();
  const npeak = 0.22 * gMaster;
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.linearRampToValueAtTime(npeak, now + totalSec);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + totalSec + 0.08);
  src.connect(filter).connect(ng).connect(out);
  src.start(now);
  src.stop(now + totalSec + 0.12);

  duckMusic(c, 0.2, durationMs + 100);
}

/** Crash de prato + kick sub — impacto do clímax. */
export async function playCrash() {
  if (prefs.muted) return;
  vibrate([60, 40, 120]);
  const c = await ensureRunning();
  if (!c) return;
  const gMaster = busGain("sfx");
  if (gMaster <= 0) return;
  const out = getMaster(c);
  const now = c.currentTime + 0.01;

  // Kick sub 55Hz
  const kick = c.createOscillator();
  kick.type = "sine";
  kick.frequency.setValueAtTime(160, now);
  kick.frequency.exponentialRampToValueAtTime(45, now + 0.12);
  const kg = c.createGain();
  const kpeak = 0.55 * gMaster;
  kg.gain.setValueAtTime(0.0001, now);
  kg.gain.exponentialRampToValueAtTime(kpeak, now + 0.005);
  kg.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
  kick.connect(kg).connect(out);
  kick.start(now);
  kick.stop(now + 0.55);

  // Crash (ruído brilhante decaindo)
  const src = c.createBufferSource();
  src.buffer = getNoiseBuffer(c);
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 3500;
  hp.Q.value = 0.7;
  const ng = c.createGain();
  const npeak = 0.4 * gMaster;
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.exponentialRampToValueAtTime(npeak, now + 0.005);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
  src.connect(hp).connect(ng).connect(out);
  src.start(now);
  src.stop(now + 1.3);

  duckMusic(c, 0.35, 300);
}

/** Tick de relógio ambiente — usado durante a votação para criar tensão sutil. */
export async function playClockTick() {
  await play(
    "ui",
    [
      { freq: 2200, start: 0.0, dur: 0.02, gain: 0.06, type: "triangle" },
      { freq: 1100, start: 0.0, dur: 0.03, gain: 0.04, type: "sine" },
    ],
    { jitterCents: 12 },
  );
}

/**
 * Sequência cinematográfica de revelação:
 * drumroll (build-up) → silêncio dramático → crash + stinger.
 * Retorna o offset (ms) em que o clímax acontece, para sincronizar com a UI.
 */
export async function playRevealBuildUp(): Promise<void> {
  if (prefs.muted) return;
  // Build-up cinematográfico:
  //  0-900ms   : drumroll acelerando
  //  700-1060ms: riser tonal (já existente) + swell de ruído rosa crescendo
  //  1060-1140ms: silêncio dramático (80ms de "respiração")
  //  1140ms    : CRASH + acorde tenso
  void playDrumRoll(900);
  setTimeout(() => {
    void playRiser(420);
  }, 700);
  // Swell de ruído rosa subindo — tensão cinematográfica que se interrompe
  // bruscamente no silêncio antes do impacto.
  setTimeout(() => {
    void playNoise({
      duration: 0.36,
      filterType: "lowpass",
      filterStart: 600,
      filterEnd: 3200,
      q: 0.7,
      peakGain: 0.18,
      attack: 0.3, // crescendo lento (quase todo o som é attack)
      release: 0.05, // corte abrupto → cria o "vácuo" antes do BOOM
      duck: true,
    });
  }, 700);
  // Silêncio de 80ms entre 1060ms e 1140ms (gap entre fim do swell e o crash)
  setTimeout(() => {
    void playCrash();
  }, 1140);
}

/** Reação coletiva: muitos caíram na pegadinha → "OOH" alto. */
export async function playCrowdReactionFooled(count: number) {
  if (count >= 3) {
    await playCrowdOoh();
    setTimeout(() => {
      void playCrowdAah();
    }, 350);
  } else if (count >= 2) {
    await playCrowdOoh();
  } else if (count === 1) {
    // micro "ooh" — usa Aah pequeno
    await play(
      "sfx",
      [
        {
          freq: 420,
          start: 0.0,
          dur: 0.35,
          gain: 0.1,
          type: "sine",
          glideTo: 360,
        },
        {
          freq: 520,
          start: 0.0,
          dur: 0.35,
          gain: 0.08,
          type: "sine",
          glideTo: 440,
        },
      ],
      { duck: true },
    );
  }
}

/** Reação coletiva: ninguém acertou a verdadeira → "AAH" decepcionado. */
export async function playCrowdReactionNoOne() {
  await playCrowdAah();
}

// ============================================================
// Sprint 2 — Magnitude scaling: o som cresce com o feito
// ============================================================

/**
 * "Você ganhou pontos" escalado pela quantidade.
 * 1pt: arpejo básico. 2pts: arpejo + brilho. 3+pts: fanfarra curta + sino.
 */
export async function playPointMagnitude(points: number) {
  if (points <= 0) return;
  if (points >= 3) {
    // Fanfarra: 4 notas ascendentes (G-B-D-G) + acorde sustentado + sino
    await play(
      "sfx",
      [
        { freq: 392.0, start: 0.0, dur: 0.1, gain: 0.26, type: "triangle" }, // G4
        { freq: 493.88, start: 0.08, dur: 0.1, gain: 0.26, type: "triangle" }, // B4
        { freq: 587.33, start: 0.16, dur: 0.1, gain: 0.26, type: "triangle" }, // D5
        { freq: 783.99, start: 0.24, dur: 0.18, gain: 0.3, type: "triangle" }, // G5
        // acorde G maior sustentado
        { freq: 392.0, start: 0.4, dur: 0.55, gain: 0.18, type: "sine" },
        { freq: 493.88, start: 0.4, dur: 0.55, gain: 0.16, type: "sine" },
        { freq: 587.33, start: 0.4, dur: 0.55, gain: 0.16, type: "sine" },
        { freq: 783.99, start: 0.4, dur: 0.55, gain: 0.14, type: "sine" },
        // sino agudo de coroa
        { freq: 1567.98, start: 0.45, dur: 0.5, gain: 0.1, type: "sine" },
        { freq: 2349.32, start: 0.48, dur: 0.4, gain: 0.06, type: "sine" },
      ],
      { vibrate: [50, 40, 50, 40, 160], duck: true },
    );
    return;
  }
  if (points === 2) {
    await play(
      "sfx",
      [
        { freq: 698.46, start: 0.0, dur: 0.09, gain: 0.22, type: "triangle" }, // F5
        { freq: 880.0, start: 0.07, dur: 0.09, gain: 0.22, type: "triangle" }, // A5
        { freq: 1046.5, start: 0.14, dur: 0.09, gain: 0.22, type: "triangle" }, // C6
        { freq: 1396.91, start: 0.21, dur: 0.14, gain: 0.26, type: "triangle" }, // F6
        { freq: 2093.0, start: 0.28, dur: 0.3, gain: 0.18, type: "sine" }, // C7 sustain
        { freq: 2793.83, start: 0.3, dur: 0.22, gain: 0.08, type: "sine" }, // brilho
      ],
      { vibrate: [40, 40, 100], duck: true },
    );
    return;
  }
  // 1pt: usa o playPointGained existente
  await playPointGained();
}

/**
 * "Você enganou X pessoas" escalado.
 * 1: risadinha leve. 2: risadinha + sino. 3+: stinger "GOTCHA" épico com fanfarra.
 */
export async function playFooledOthersMagnitude(count: number) {
  if (count <= 0) return;
  if (count >= 3) {
    // Rim shot + fanfarra ascendente épica + acorde maior brilhante
    const c = await ensureRunning();
    if (c) {
      const out = getMaster(c);
      const gM = busGain("sfx");
      const now = c.currentTime + 0.01;
      // Rimshot grave
      const k = c.createOscillator();
      k.type = "square";
      k.frequency.setValueAtTime(280, now);
      k.frequency.exponentialRampToValueAtTime(60, now + 0.08);
      const kg = c.createGain();
      kg.gain.setValueAtTime(0.0001, now);
      kg.gain.exponentialRampToValueAtTime(0.45 * gM, now + 0.004);
      kg.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      k.connect(kg).connect(out);
      k.start(now);
      k.stop(now + 0.2);
    }
    // Risada subindo + fanfarra "GOTCHA"
    await play(
      "sfx",
      [
        { freq: 587, start: 0.0, dur: 0.04, gain: 0.2, type: "triangle" },
        { freq: 784, start: 0.04, dur: 0.04, gain: 0.2, type: "triangle" },
        { freq: 988, start: 0.08, dur: 0.04, gain: 0.2, type: "triangle" },
        { freq: 1175, start: 0.12, dur: 0.04, gain: 0.2, type: "triangle" },
        { freq: 1568, start: 0.16, dur: 0.06, gain: 0.22, type: "triangle" },
        // fanfarra "ta-DAA"
        { freq: 783.99, start: 0.3, dur: 0.1, gain: 0.26, type: "triangle" }, // G5
        { freq: 1046.5, start: 0.4, dur: 0.1, gain: 0.26, type: "triangle" }, // C6
        { freq: 1318.51, start: 0.5, dur: 0.28, gain: 0.3, type: "triangle" }, // E6
        // acorde C maior sustentado
        { freq: 523.25, start: 0.55, dur: 0.65, gain: 0.18, type: "sine" },
        { freq: 659.25, start: 0.55, dur: 0.65, gain: 0.16, type: "sine" },
        { freq: 783.99, start: 0.55, dur: 0.65, gain: 0.16, type: "sine" },
        { freq: 1046.5, start: 0.55, dur: 0.65, gain: 0.14, type: "sine" },
        // sino top
        { freq: 2093.0, start: 0.62, dur: 0.58, gain: 0.08, type: "sine" },
      ],
      { vibrate: [80, 60, 80, 60, 220], duck: true },
    );
    // "OOH" de público logo depois reforça
    setTimeout(() => {
      void playCrowdOoh();
    }, 180);
    return;
  }
  if (count === 2) {
    // Risadinha + sino brilhante
    await play(
      "sfx",
      [
        { freq: 587, start: 0.0, dur: 0.05, gain: 0.18, type: "triangle" },
        { freq: 784, start: 0.05, dur: 0.05, gain: 0.18, type: "triangle" },
        { freq: 988, start: 0.1, dur: 0.05, gain: 0.18, type: "triangle" },
        { freq: 1175, start: 0.15, dur: 0.06, gain: 0.2, type: "triangle" },
        { freq: 1568, start: 0.22, dur: 0.18, gain: 0.24, type: "triangle" },
        { freq: 2093, start: 0.28, dur: 0.2, gain: 0.1, type: "sine" },
        { freq: 3136, start: 0.3, dur: 0.16, gain: 0.05, type: "sine" }, // sparkle
      ],
      { vibrate: [40, 40, 120], jitterCents: 14, duck: true },
    );
    return;
  }
  // 1 pessoa: usa o playFooledOthers original
  await playFooledOthers();
}

/**
 * "Você foi enganado" escalado — quantos votaram errado (incluindo você).
 * Mais gente errou = mais "pesado" o trombone para criar comédia coletiva.
 */
export async function playFooledMagnitude(totalFooled: number) {
  if (totalFooled >= 3) {
    // Trombone wah-wah grave + extra "thud" final
    await play(
      "sfx",
      [
        {
          freq: 466.16,
          start: 0.0,
          dur: 0.24,
          gain: 0.26,
          type: "sawtooth",
          glideTo: 369.99,
        },
        {
          freq: 369.99,
          start: 0.24,
          dur: 0.26,
          gain: 0.24,
          type: "sawtooth",
          glideTo: 277.18,
        },
        {
          freq: 277.18,
          start: 0.5,
          dur: 0.3,
          gain: 0.24,
          type: "sawtooth",
          glideTo: 196.0,
        },
        {
          freq: 196.0,
          start: 0.8,
          dur: 0.42,
          gain: 0.26,
          type: "triangle",
          glideTo: 130.81,
        },
        // thud final
        {
          freq: 110.0,
          start: 1.2,
          dur: 0.4,
          gain: 0.3,
          type: "sine",
          glideTo: 55.0,
        },
      ],
      { vibrate: [40, 80, 40, 80, 160], duck: true },
    );
    return;
  }
  // 1-2 pessoas: trombone padrão
  await playFooled();
}

// ============================================================
// Sprint 3 — Streak, Perfect Round, Savage stingers
// ============================================================

/** Streak — você pontuou em rodadas seguidas. Pitch escala com o tamanho. */
export async function playStreak(streakCount: number) {
  if (streakCount < 2) return;
  const c = await ensureRunning();
  if (!c) return;
  const gM = busGain("sfx");
  if (gM <= 0) return;
  const out = getMaster(c);
  const now = c.currentTime + 0.01;
  // Sequência de N notas ascendentes com pitch acelerado
  const baseFreq = 523.25; // C5
  const notes = Math.min(streakCount, 6);
  for (let i = 0; i < notes; i++) {
    const osc = c.createOscillator();
    const g = c.createGain();
    const pan = createSubtlePanner(c, (i - notes / 2) * 0.15);
    osc.type = "triangle";
    osc.frequency.setValueAtTime(
      baseFreq * Math.pow(1.122, i * 2),
      now + i * 0.08,
    );
    const peak = 0.22 * gM;
    g.gain.setValueAtTime(0.0001, now + i * 0.08);
    g.gain.exponentialRampToValueAtTime(peak, now + i * 0.08 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.12);
    let chain: AudioNode = g;
    osc.connect(g);
    if (pan) {
      g.connect(pan);
      chain = pan;
    }
    chain.connect(out);
    osc.start(now + i * 0.08);
    osc.stop(now + i * 0.08 + 0.16);
  }
  // Sino brilhante no topo
  const bell = c.createOscillator();
  const bg = c.createGain();
  bell.type = "sine";
  bell.frequency.value = baseFreq * Math.pow(1.122, notes * 2);
  bg.gain.setValueAtTime(0.0001, now + notes * 0.08);
  bg.gain.exponentialRampToValueAtTime(0.14 * gM, now + notes * 0.08 + 0.02);
  bg.gain.exponentialRampToValueAtTime(0.0001, now + notes * 0.08 + 0.7);
  bell.connect(bg).connect(out);
  bell.start(now + notes * 0.08);
  bell.stop(now + notes * 0.08 + 0.75);
  vibrate([20, 30, 20, 30, 60]);
  duckMusic(c, 0.4, 600);
}

/** Perfect round — TODOS votaram na sua definição (você enganou a sala inteira). */
export async function playPerfectRound() {
  // Crash + fanfarra C maior + sino dourado + crowd OOH
  void playCrash();
  setTimeout(() => {
    void play(
      "sfx",
      [
        // Fanfarra ascendente C-E-G-C
        { freq: 523.25, start: 0.0, dur: 0.12, gain: 0.3, type: "triangle" },
        { freq: 659.25, start: 0.1, dur: 0.12, gain: 0.3, type: "triangle" },
        { freq: 783.99, start: 0.2, dur: 0.12, gain: 0.3, type: "triangle" },
        { freq: 1046.5, start: 0.3, dur: 0.32, gain: 0.34, type: "triangle" },
        // Acorde sustentado C maj9
        { freq: 523.25, start: 0.5, dur: 1.1, gain: 0.2, type: "sine" },
        { freq: 659.25, start: 0.5, dur: 1.1, gain: 0.18, type: "sine" },
        { freq: 783.99, start: 0.5, dur: 1.1, gain: 0.18, type: "sine" },
        { freq: 1046.5, start: 0.5, dur: 1.1, gain: 0.16, type: "sine" },
        { freq: 1318.51, start: 0.5, dur: 1.1, gain: 0.12, type: "sine" }, // 9ª
        // Sino dourado top
        { freq: 2093.0, start: 0.55, dur: 1.0, gain: 0.1, type: "sine" },
        { freq: 3135.96, start: 0.6, dur: 0.9, gain: 0.06, type: "sine" },
      ],
      { vibrate: [80, 60, 80, 60, 200, 80, 200], duck: true },
    );
  }, 120);
  setTimeout(() => {
    void playCrowdOoh();
  }, 350);
  setTimeout(() => {
    void playCrowdAah();
  }, 700);
}

/** Savage — você enganou 4+ pessoas. Stinger ácido, brincalhão e maléfico. */
export async function playSavage() {
  void playCrash();
  setTimeout(() => {
    void play(
      "sfx",
      [
        // "Rrrrr" descendente (vilanesco)
        {
          freq: 880,
          start: 0.0,
          dur: 0.18,
          gain: 0.22,
          type: "sawtooth",
          glideTo: 220,
        },
        // Risada aguda subindo
        { freq: 587, start: 0.2, dur: 0.05, gain: 0.2, type: "square" },
        { freq: 740, start: 0.25, dur: 0.05, gain: 0.2, type: "square" },
        { freq: 880, start: 0.3, dur: 0.05, gain: 0.2, type: "square" },
        { freq: 1109, start: 0.35, dur: 0.05, gain: 0.2, type: "square" },
        { freq: 1397, start: 0.4, dur: 0.08, gain: 0.22, type: "square" },
        { freq: 1760, start: 0.48, dur: 0.2, gain: 0.26, type: "triangle" },
        // Acorde dissonante grave (suspense malicioso)
        { freq: 110.0, start: 0.65, dur: 0.75, gain: 0.22, type: "sawtooth" }, // A2
        { freq: 138.59, start: 0.65, dur: 0.75, gain: 0.18, type: "sawtooth" }, // C#3
        { freq: 220.0, start: 0.7, dur: 0.7, gain: 0.16, type: "sine" }, // A3
      ],
      { vibrate: [60, 40, 60, 40, 60, 40, 220], jitterCents: 12, duck: true },
    );
  }, 100);
  setTimeout(() => {
    void playCrowdOoh();
  }, 350);
  setTimeout(() => {
    void playCrowdAah();
  }, 1100);
}

// ============================================================
// Transição "Embaralhando as cédulas" — som simples e agradável
// ============================================================
/**
 * Shuffling — versão simplificada:
 *   1) Whoosh suave de abertura (200ms) — anuncia o movimento sem agressividade.
 *   2) Dois riffles leves de papel em stereo (esq→dir) — sugerem o leque das
 *      cartas, sem poluir o mix.
 *   3) Resolução musical curta: tríade clara em C (C-E-G) tipo "celesta", com
 *      brilho discreto. Total ~1.3s — limpo, claro e convidativo.
 */
export async function playCardShuffle() {
  if (prefs.muted) return;

  // Som único e minimalista de papel sendo embaralhado — apenas um riffle curto.
  void playNoise({
    duration: 0.18,
    filterType: "bandpass",
    filterStart: 1600,
    filterEnd: 2800,
    q: 1.8,
    peakGain: 0.012,
    attack: 0.02,
    release: 0.1,
    duck: true,
  });
}

/**
 * Tail Freeze — "câmera lenta" sonora ao fim da rodada antes do scoreboard.
 * Toca um drone harmônico longo (D maior) com release de ~1.2s que se dissolve
 * no reverb, enquanto a música é duckada profundamente. Cria sensação de
 * "respirar fundo" antes da pontuação aparecer.
 *
 * Duração total ~1.4s — chame ~1.4s antes da transição para o scoreboard.
 */
export async function playTailFreeze() {
  if (prefs.muted) return;
  const c = await ensureRunning();
  if (!c) return;
  const out = getMaster(c);
  const gM = busGain("sfx");
  if (gM <= 0) return;
  // Duck profundo na música (15% por 1.2s) — silêncio quase total
  duckMusic(c, 0.15, 1200);
  const now = c.currentTime + 0.01;
  // Drone D maior aberto (D3-A3-D4-F#4) com release longo
  const notes = [146.83, 220.0, 293.66, 369.99];
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.detune.value = (Math.random() * 2 - 1) * 4;
    const g = c.createGain();
    const peak = (0.08 - i * 0.012) * gM; // grave mais forte que agudo
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.18); // attack lento
    g.gain.setValueAtTime(peak, now + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.35); // release 1s
    // Lowpass que fecha — simula "câmera lenta" abafando os agudos
    const filt = c.createBiquadFilter();
    filt.type = "lowpass";
    filt.Q.value = 0.7;
    filt.frequency.setValueAtTime(3200, now);
    filt.frequency.exponentialRampToValueAtTime(600, now + 1.2);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now);
    osc.stop(now + 1.45);
  });
}
