import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Áudio depois do background (playtest 2026-10-22, iPhone): ao voltar de
// outro app o som morria. O WebKit deixa o contexto em "interrupted" — e o
// código só retomava "suspended". Aqui um AudioContext de mentira reproduz os
// estados do ciclo de vida (running → interrupted/suspended/closed → volta).
type Behavior = "ok" | "fail" | "hang";

class FakeParam {
  value = 0;
  setValueAtTime() {
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
  exponentialRampToValueAtTime() {
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  setTargetAtTime() {
    return this;
  }
}

class FakeCtx {
  static instances: FakeCtx[] = [];
  static nextResume: Behavior = "ok";
  state: string = "suspended";
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  started = 0;
  resumeCalls = 0;
  resumeBehavior: Behavior = FakeCtx.nextResume;
  /** O próprio proxy (é o que o app recebe de `new AudioContext()`). */
  self: FakeCtx = this;
  constructor() {
    const proxy = new Proxy(this, {
      get(t, k: string | symbol) {
        if (typeof k === "string" && k.startsWith("create") && !(k in t))
          return () => t.node();
        return (t as unknown as Record<string | symbol, unknown>)[k];
      },
    });
    this.self = proxy;
    FakeCtx.instances.push(proxy);
    return proxy;
  }
  node() {
    const self = this.self;
    const n: Record<string, unknown> = {
      context: self,
      // como no navegador: ligar nós de contextos diferentes é erro
      connect: (x: unknown) => {
        const other = (x as { context?: unknown } | null)?.context;
        if (other && other !== self)
          throw new Error("InvalidAccessError: nós de contextos diferentes");
        return x;
      },
      disconnect: () => {},
      start: () => {
        this.started++;
      },
      stop: () => {},
      buffer: null,
      curve: null,
    };
    for (const k of [
      "gain",
      "frequency",
      "Q",
      "detune",
      "pan",
      "threshold",
      "knee",
      "ratio",
      "attack",
      "release",
      "playbackRate",
      "delayTime",
    ])
      n[k] = new FakeParam();
    return n;
  }
  createBuffer(_ch: number, len: number, rate: number) {
    return {
      sampleRate: rate,
      length: len,
      getChannelData: () => new Float32Array(len),
    };
  }
  resume() {
    this.resumeCalls++;
    if (this.resumeBehavior === "ok") {
      this.state = "running";
      return Promise.resolve();
    }
    if (this.resumeBehavior === "fail")
      return Promise.reject(new Error("not allowed"));
    return new Promise<void>(() => {});
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

type SoundModule = typeof import("@/lib/sound");
const setVisibility = (v: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => v,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};
const tap = () => window.dispatchEvent(new Event("pointerdown"));
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const live = () => FakeCtx.instances.filter((c) => c.state !== "closed");

async function load(prefs?: { muted: boolean; volume: number }) {
  vi.resetModules();
  FakeCtx.instances = [];
  FakeCtx.nextResume = "ok";
  localStorage.clear();
  if (prefs) localStorage.setItem("verbete:audio:v1", JSON.stringify(prefs));
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
  const m: SoundModule = await import("@/lib/sound");
  m.installAudioUnlock();
  // primeiro toque da sessão destrava o áudio
  tap();
  await m.primeAudio(true);
  return m;
}

describe("áudio depois de minimizar / trocar de app", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    setVisibility("visible");
  });
  afterEach(() => vi.useRealTimers());

  it("A) som funcionando → background → retorno → o próximo SFX toca", async () => {
    const m = await load();
    const c = FakeCtx.instances[0]!;
    expect(c.state).toBe("running");
    await m.playUITap();
    const before = c.started;
    expect(before).toBeGreaterThan(0);
    setVisibility("hidden");
    c.state = "interrupted"; // o que o WebKit faz ao trocar de app
    c.resumeBehavior = "fail"; // fora de um toque o iOS não deixa
    setVisibility("visible");
    await flush();
    tap(); // primeiro toque depois de voltar
    await m.primeAudio(true);
    const now = live();
    expect(now).toHaveLength(1);
    expect(now[0]!.state).toBe("running");
    await m.playUITap();
    expect(now[0]!.started).toBeGreaterThan(0);
  });

  it("B) contexto 'suspended' volta sozinho na volta à tela (Android/web)", async () => {
    const m = await load();
    const c = FakeCtx.instances[0]!;
    c.state = "suspended";
    setVisibility("visible");
    await m.primeAudio(false);
    expect(c.state).toBe("running");
    expect(FakeCtx.instances).toHaveLength(1); // sem recriar à toa
  });

  it("C) contexto 'closed'/inválido é recriado — e o bus master também", async () => {
    const m = await load();
    const old = FakeCtx.instances[0]!;
    old.state = "closed";
    tap();
    await m.primeAudio(true);
    const fresh = live();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).not.toBe(old);
    await m.playUITap();
    expect(fresh[0]!.started).toBeGreaterThan(0);
    expect(m.getAudioContext()).toBe(fresh[0]);
  });

  it("D) vários ciclos background/foreground: segue tocando, um contexto vivo só", async () => {
    const m = await load();
    for (let i = 0; i < 4; i++) {
      const c = live()[0]!;
      setVisibility("hidden");
      c.state = "interrupted";
      c.resumeBehavior = "fail";
      setVisibility("visible");
      await flush();
      tap();
      await m.primeAudio(true);
      expect(live(), `ciclo ${i + 1}`).toHaveLength(1);
      const cur = live()[0]!;
      const before = cur.started;
      await m.playUITap();
      expect(cur.started, `ciclo ${i + 1}: SFX`).toBeGreaterThan(before);
    }
  });

  it("E) mute persistido continua mudo depois de voltar", async () => {
    const m = await load({ muted: true, volume: 0.8 });
    const c = FakeCtx.instances[0]!;
    setVisibility("hidden");
    c.state = "interrupted";
    setVisibility("visible");
    tap();
    await m.primeAudio(true);
    expect(m.getAudioPrefs().muted).toBe(true);
    const cur = live()[0]!;
    const before = cur.started;
    await m.playUITap();
    expect(cur.started - before).toBe(0);
  });

  it("F) som ativo segue ativo depois de voltar", async () => {
    const m = await load({ muted: false, volume: 0.8 });
    const c = FakeCtx.instances[0]!;
    c.state = "suspended";
    setVisibility("visible");
    await m.primeAudio(false);
    expect(m.getAudioPrefs().muted).toBe(false);
    const before = c.started;
    await m.playUITap();
    expect(c.started).toBeGreaterThan(before);
  });

  it("sem som duplicado: fora de 'running' o SFX é descartado (não toca tudo junto na volta)", async () => {
    const m = await load();
    const c = FakeCtx.instances[0]!;
    c.state = "interrupted";
    c.resumeBehavior = "hang"; // resume() fora do toque fica pendurado
    const queued = c.started;
    const p = m.playUITap();
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(c.started, "SFX fora de 'running' não é agendado").toBe(queued);
    tap();
    await m.primeAudio(true);
    await flush();
    // na volta não chega uma rajada: só o buffer mudo do destravamento
    const cur = live()[0]!;
    expect(cur.started - (cur === c ? queued : 0)).toBeLessThanOrEqual(1);
  });

  it("vários eventos do mesmo toque não criam vários contextos", async () => {
    const m = await load();
    const c = FakeCtx.instances[0]!;
    c.state = "interrupted";
    c.resumeBehavior = "fail";
    for (const ev of ["pointerdown", "touchstart", "touchend", "click"])
      window.dispatchEvent(new Event(ev));
    await m.primeAudio(true);
    expect(live()).toHaveLength(1);
    expect(FakeCtx.instances.length).toBeLessThanOrEqual(2);
  });

  it("G) Android/web sem regressão: sem background, nada é recriado nem retomado", async () => {
    const m = await load();
    const c = FakeCtx.instances[0]!;
    const calls = c.resumeCalls;
    tap();
    await m.primeAudio(true);
    await m.playUITap();
    expect(FakeCtx.instances).toHaveLength(1);
    expect(c.resumeCalls).toBe(calls);
    expect(m.getAudioLifecycleLog().length).toBeGreaterThan(0);
  });
});

// Red Team 2026-10-22: a música passou a usar o MESMO contexto dos efeitos.
describe("música no contexto compartilhado", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    setVisibility("visible");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function loadMusic(opts: { tap?: boolean; resume?: Behavior } = {}) {
    vi.resetModules();
    FakeCtx.instances = [];
    FakeCtx.nextResume = opts.resume ?? "ok";
    localStorage.clear();
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
    const m: SoundModule = await import("@/lib/sound");
    const mu = await import("@/lib/music");
    m.installAudioUnlock();
    if (opts.tap !== false) {
      tap();
      await m.primeAudio(true);
    }
    return { m, mu };
  }

  it("P1: com o contexto parado nada entra na fila — o 1º toque não estoura batidas", async () => {
    const { m, mu } = await loadMusic({ tap: false, resume: "fail" });
    await m.primeAudio(false); // montagem da sala, fora de um toque
    const c = FakeCtx.instances[0]!;
    expect(c.state).toBe("suspended");
    mu.setMusicMood("lobby");
    const afterStart = c.started; // pads e LFO sustentados, uma vez
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.started - afterStart, "batidas/arpejos na fila").toBe(0);
    c.resumeBehavior = "ok";
    tap(); // 1º toque: retoma e segue no ritmo
    await m.primeAudio(true);
    const cur = live()[0]!;
    const before = cur.started;
    await vi.advanceTimersByTimeAsync(1_000);
    // re-arme (pads + LFO + 1ª batida) + ~1 s de arpejo/batida
    expect(cur.started - before).toBeLessThanOrEqual(12);
    mu.stopMusic();
  });

  it("#2: trocar de aba com o contexto rodando (Android/desktop) não reinicia a música", async () => {
    const { m, mu } = await loadMusic();
    const c = FakeCtx.instances[0]!;
    mu.setMusicMood("lobby");
    await vi.advanceTimersByTimeAsync(2_000);
    setVisibility("hidden");
    setVisibility("visible");
    const before = c.started;
    await m.primeAudio(false);
    expect(c.started - before, "pads/LFO/batida de novo").toBe(0);
    mu.stopMusic();
  });

  it("#3: contexto recriado — a música volta no novo e o loop antigo não liga nós cruzados", async () => {
    const { m, mu } = await loadMusic();
    mu.setMusicMood("tension");
    const old = FakeCtx.instances[0]!;
    await vi.advanceTimersByTimeAsync(2_000);
    setVisibility("hidden");
    old.state = "interrupted";
    old.resumeBehavior = "fail";
    setVisibility("visible");
    // o loop vê o contexto parado; o toque cai 50 ms antes do próximo
    // arpejo (a cada 550 ms) — dentro da janela em que o loop antigo ainda
    // vive (100 ms)
    await vi.advanceTimersByTimeAsync(700);
    tap();
    await m.primeAudio(true);
    const fresh = live()[0]!;
    expect(fresh).not.toBe(old);
    const oldStarted = old.started;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(old.started, "loop antigo parou").toBe(oldStarted);
    expect(fresh.started, "música no contexto novo").toBeGreaterThan(5);
    mu.stopMusic();
  });

  it("#4: toque no meio da tentativa de volta religa a música no contexto novo", async () => {
    const { m, mu } = await loadMusic();
    mu.setMusicMood("lobby");
    const hook = vi.fn();
    m.registerAudioLifecycleHook(hook);
    const old = FakeCtx.instances[0]!;
    setVisibility("hidden");
    old.state = "interrupted";
    old.resumeBehavior = "hang"; // fora do toque, o resume() fica pendurado
    setVisibility("visible"); // começa a tentativa (até 400 ms)
    tap(); // o toque chega no meio dela e recria o contexto
    const p = m.primeAudio(true);
    await vi.advanceTimersByTimeAsync(500);
    await p;
    const fresh = live();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).not.toBe(old);
    expect(hook).toHaveBeenLastCalledWith(fresh[0]);
    mu.stopMusic();
  });

  it("#4: play() do fallback que nunca responde não prende as próximas voltas", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
      () => new Promise<void>(() => {}),
    );
    const { m } = await loadMusic({ tap: false });
    const hook = vi.fn();
    m.registerAudioLifecycleHook(hook);
    void m.primeAudio(true);
    await vi.advanceTimersByTimeAsync(1_500);
    const calls = hook.mock.calls.length;
    void m.primeAudio(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(hook.mock.calls.length, "nova tentativa rodou").toBeGreaterThan(
      calls,
    );
  });

  it("#5: ligação (o iOS segura o áudio) — tocar várias vezes não cria um contexto por toque", async () => {
    const { m } = await loadMusic();
    const c = FakeCtx.instances[0]!;
    setVisibility("hidden");
    c.state = "interrupted";
    setVisibility("visible");
    FakeCtx.nextResume = "fail"; // durante a ligação nenhum contexto volta
    for (let i = 0; i < 5; i++) {
      tap();
      await m.primeAudio(true);
      for (const x of live()) x.state = "interrupted";
    }
    expect(FakeCtx.instances.length).toBeLessThanOrEqual(2);
    expect(live()).toHaveLength(1);
  });
});
