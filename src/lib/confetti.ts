// Confete baseado em canvas-confetti.
// O pacote é carregado dinamicamente para não entrar no bundle inicial —
// só baixa no primeiro momento de celebração (revelação/vitória).
type ConfettiFn = (opts?: Record<string, unknown>) => void;
let _confetti: ConfettiFn | null = null;
let _loading: Promise<ConfettiFn | null> | null = null;

function load(): Promise<ConfettiFn | null> {
  if (_confetti) return Promise.resolve(_confetti);
  if (_loading) return _loading;
  _loading = import("canvas-confetti")
    .then((m) => {
      _confetti = m.default as ConfettiFn;
      return _confetti;
    })
    .catch(() => null);
  return _loading;
}

const PINK = "#ff4d8d";
const MINT = "#5cf2c5";
const SUN = "#ffd84d";
const PURPLE = "#a78bfa";
const WHITE = "#ffffff";
const PALETTE = [PINK, MINT, SUN, PURPLE, WHITE];

/** Pequeno burst no centro — usado em revelação / acerto. */
export async function burst(opts?: { particleCount?: number; spread?: number; origin?: { x: number; y: number } }) {
  const c = await load();
  if (!c) return;
  try {
    c({
      particleCount: opts?.particleCount ?? 80,
      spread: opts?.spread ?? 70,
      origin: opts?.origin ?? { x: 0.5, y: 0.55 },
      colors: PALETTE,
      scalar: 0.9,
      ticks: 180,
      gravity: 1.1,
      disableForReducedMotion: true,
    });
  } catch {}
}

/** Burst lateral duplo (esquerda + direita) — vitória de rodada. */
export async function sideCannons() {
  const c = await load();
  if (!c) return;
  try {
    const end = Date.now() + 600;
    const frame = () => {
      c({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0, y: 0.7 }, colors: PALETTE, disableForReducedMotion: true });
      c({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1, y: 0.7 }, colors: PALETTE, disableForReducedMotion: true });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  } catch {}
}

/** Chuva grandiosa — vitória final do jogo. */
export async function fireworks() {
  const c = await load();
  if (!c) return;
  try {
    const duration = 2400;
    const end = Date.now() + duration;
    const defaults = { startVelocity: 32, spread: 360, ticks: 60, zIndex: 9999, colors: PALETTE, disableForReducedMotion: true };
    const interval = window.setInterval(() => {
      if (Date.now() > end) { window.clearInterval(interval); return; }
      const particleCount = 50;
      c({ ...defaults, particleCount, origin: { x: Math.random() * 0.3 + 0.1, y: Math.random() - 0.2 } });
      c({ ...defaults, particleCount, origin: { x: Math.random() * 0.3 + 0.6, y: Math.random() - 0.2 } });
    }, 220);
  } catch {}
}


