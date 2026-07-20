import { APP_URL } from "@/lib/app-url";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
// Mascot removido — o banner hero (verbete-hero) já é o elemento visual principal.
import { AVATARS, COLORS, randomAvatar, randomColor } from "@/lib/avatars";
import { sanitizeNickname } from "@/lib/text-filter";
import { getPlayerId, getStored, setStored } from "@/lib/player-id";
import { createRoom, joinRoom } from "@/lib/room";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SoundToggle } from "@/components/SoundToggle";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { supabase } from "@/integrations/supabase/client";


// Carregados sob demanda: nenhum aparece no bundle inicial da home.
const Onboarding = lazy(() => import("@/components/Onboarding").then((m) => ({ default: m.Onboarding })));
const HomeStatsCard = lazy(() => import("@/components/HomeStatsCard").then((m) => ({ default: m.HomeStatsCard })));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Verbete — Ganhar conhecimento nunca foi tão divertido!" },
      { name: "description", content: "Verbete: conhecimento nunca foi tão divertido. Multiplayer em tempo real para até 12 amigos blefarem com palavras raras." },
      { property: "og:title", content: "Verbete — Ganhar conhecimento nunca foi tão divertido!" },
      { property: "og:description", content: "Multiplayer em tempo real para até 12 amigos. Blefa, vota e ri muito." },
      { property: "og:url", content: `${APP_URL}/` },
    ],
    links: [{ rel: "canonical", href: `${APP_URL}/` }],
  }),
  component: HomePage,
});

function HomePage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { theme } = useTheme();
  const isLight = theme === "light";
  const handleSignOut = async () => { await supabase.auth.signOut(); };
  const [mode, setMode] = useState<"home" | "host" | "join">("home");
  const [nick, setNick] = useState<string>(() => getStored("nick", ""));
  const [avatar, setAvatar] = useState<string>(() => getStored("avatar", randomAvatar()));
  const [color, setColor] = useState<string>(() => getStored("color", randomColor()));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Deep-link: /?join=1234 → abre direto o fluxo de entrada com código preenchido.
  // Padrão usado pelo botão Compartilhar — mantém o jogador no fluxo natural
  // mesmo se receber o link sem ter o app instalado/aberto.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const join = params.get("join");
    if (join && /^\d{4}$/.test(join)) {
      setCode(join);
      setMode("join");
    }
  }, []);

  const playerId = typeof window !== "undefined" ? getPlayerId() : "";

  const persist = () => {
    setStored("nick", nick);
    setStored("avatar", avatar);
    setStored("color", color);
  };

  const handleHost = async () => {
    setError(null);
    const cleanNick = sanitizeNickname(nick);
    if (!cleanNick || cleanNick === "Anônimo") { setError("Escolha um apelido"); return; }
    setBusy(true);
    try {
      persist();
      const room = await createRoom(playerId, cleanNick, avatar, color);
      // Marca este jogador como criador desta sala — usado para restaurar
      // identidade de host caso o /room/$code seja aberto em outra aba/sessão.
      setStored("hosted:" + room.code, playerId);
      nav({ to: "/room/$code", params: { code: room.code } });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const handleJoin = async () => {
    setError(null);
    const cleanNick = sanitizeNickname(nick);
    if (!cleanNick || cleanNick === "Anônimo") { setError("Escolha um apelido"); return; }
    if (code.length !== 4) { setError("Código de 4 dígitos"); return; }
    setBusy(true);
    try {
      persist();
      const room = await joinRoom(code, playerId, cleanNick, avatar, color);
      nav({ to: "/room/$code", params: { code: room.code } });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };


  const heroGradient = isLight
    ? "linear-gradient(135deg, #ffd97a 0%, #ffb0e0 28%, #ff8fd0 52%, #b79aff 78%, #7cc7ff 100%)"
    : "linear-gradient(135deg, #ff0080 0%, #d926c6 25%, #7d12ff 55%, #3b1a9d 80%, #0066ff 100%)";
  const formBg = isLight ? "#fff6e5" : "#140630";
  const footerTextColor = isLight ? "rgba(76,26,143,0.75)" : "rgba(255,255,255,0.85)";

  return (
    <div
      className="mobile-shell relative overflow-hidden"
      style={{
        background: mode === "home" ? heroGradient : formBg,
      }}
    >

      {/* Top-bar controls (som / tema) */}
      <div
        className="absolute z-30"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 12px)",
          left: "calc(env(safe-area-inset-left, 0px) + 12px)",
        }}
      >
        <SoundToggle className="!w-11 !h-11 !rounded-full !text-base !text-white bg-white/10 backdrop-blur-md border border-white/20" />
      </div>
      <div
        className="absolute z-30"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 12px)",
          right: "calc(env(safe-area-inset-right, 0px) + 12px)",
        }}
      >
        <ThemeToggle className="!w-11 !h-11 !rounded-full !text-base !text-white !opacity-100" />
      </div>


      {mode === "home" ? (
        <>
          {/* Background — magenta → roxo → azul (dark) ou pastel sunny (light) */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden style={{ zIndex: 0 }}>
            <div
              className="absolute inset-0"
              style={{ background: heroGradient }}
            />

            {/* Glow central rosa */}
            <div
              className="absolute top-[18%] left-1/2 -translate-x-1/2 w-[420px] h-[420px] rounded-full pointer-events-none"
              style={{
                background: "radial-gradient(circle, rgba(255,0,128,0.55) 0%, transparent 70%)",
                filter: "blur(60px)",
              }}
            />
            {/* Raios de luz saindo do logo */}
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 w-[520px] h-[380px] pointer-events-none opacity-40"
              style={{
                background:
                  "conic-gradient(from 90deg at 50% 30%, transparent 0deg, rgba(255,255,255,0.25) 10deg, transparent 25deg, rgba(255,255,255,0.2) 60deg, transparent 80deg, rgba(255,255,255,0.25) 120deg, transparent 140deg)",
                filter: "blur(2px)",
              }}
            />

            {/* Confetes coloridos espalhados */}
            {[
              { l: "6%", t: "14%", c: "#ffde00", w: 4, h: 8, r: 45, d: 0 },
              { l: "12%", t: "36%", c: "#00ffd2", w: 6, h: 6, r: 0, d: 0.6, round: true },
              { l: "88%", t: "18%", c: "#ff6ec7", w: 8, h: 4, r: -12, d: 0.3 },
              { l: "80%", t: "42%", c: "#ffde00", w: 5, h: 5, r: 20, d: 1.2, round: true },
              { l: "18%", t: "62%", c: "#ffffff", w: 4, h: 4, r: 0, d: 0.9, round: true },
              { l: "82%", t: "66%", c: "#00e5ff", w: 4, h: 9, r: 30, d: 1.5 },
              { l: "48%", t: "8%", c: "#ffffff", w: 3, h: 3, r: 0, d: 0.4, round: true },
              { l: "34%", t: "48%", c: "#ff00aa", w: 6, h: 3, r: 12, d: 1.8 },
              { l: "64%", t: "28%", c: "#a3e635", w: 5, h: 5, r: 45, d: 0.7, round: true },
              { l: "8%", t: "78%", c: "#ffde00", w: 4, h: 8, r: -30, d: 2.1 },
            ].map((p, i) => (
              <motion.span
                key={i}
                aria-hidden
                className="absolute"
                style={{
                  left: p.l,
                  top: p.t,
                  width: p.w,
                  height: p.h,
                  background: p.c,
                  borderRadius: p.round ? "9999px" : "2px",
                  transform: `rotate(${p.r}deg)`,
                  boxShadow: `0 0 8px ${p.c}88`,
                }}
                animate={{ y: [0, -10, 0], opacity: [0.6, 1, 0.6] }}
                transition={{ duration: 4 + i * 0.3, repeat: Infinity, ease: "easeInOut", delay: p.d }}
              />
            ))}
          </div>

          {/* Hero — V logo + wordmark + tagline */}
          <div
            className="relative flex flex-col items-center text-center px-6"
            style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 72px)" }}
          >
            {/* Balão de interrogação — canto sup direito */}
            <motion.div
              aria-hidden
              className="absolute"
              style={{ top: "calc(env(safe-area-inset-top, 0px) + 70px)", right: "6%" }}
              animate={{ y: [0, -6, 0], rotate: [8, 12, 8] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            >
              <div
                className="relative w-14 h-14 rounded-2xl flex items-center justify-center font-display font-black text-white text-2xl"
                style={{
                  background: "linear-gradient(180deg, #4dffcf 0%, #00e5b8 100%)",
                  border: "3px solid #ffffff",
                  boxShadow: "0 6px 0 #00b892, 0 12px 20px -6px rgba(0,229,184,0.6)",
                }}
              >
                ?
                <span
                  aria-hidden
                  className="absolute -bottom-2 left-3 w-0 h-0"
                  style={{
                    borderLeft: "8px solid transparent",
                    borderRight: "8px solid transparent",
                    borderTop: "10px solid #00e5b8",
                  }}
                />
              </div>
            </motion.div>

            {/* Halo pulsante atrás do logo */}
            <motion.div
              aria-hidden
              className="absolute left-1/2 -translate-x-1/2 rounded-full pointer-events-none"
              style={{
                top: "calc(env(safe-area-inset-top, 0px) + 70px)",
                width: 260,
                height: 260,
                background: "radial-gradient(circle, rgba(255,0,150,0.7) 0%, rgba(255,0,150,0.25) 45%, transparent 75%)",
                filter: "blur(30px)",
              }}
              animate={{ scale: [1, 1.1, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
            />

            {/* Tile "V" com livro */}
            <motion.div
              initial={{ scale: 0.6, opacity: 0, rotate: -6 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 180, damping: 14 }}
              className="relative"
            >
              <div
                className="relative w-[124px] h-[124px] rounded-[28px] flex flex-col items-center justify-center"
                style={{
                  background: "linear-gradient(135deg, #ff4bb0 0%, #c026d3 50%, #6a1fd4 100%)",
                  border: "5px solid #ffffff",
                  boxShadow:
                    "0 0 40px rgba(255,0,150,0.65), 0 12px 0 rgba(76,0,128,0.35), inset 0 3px 0 rgba(255,255,255,0.35)",
                }}
              >
                <span
                  className="font-display font-black leading-none select-none"
                  style={{
                    color: "#ffffff",
                    fontSize: 82,
                    marginTop: -6,
                    marginBottom: -6,
                    letterSpacing: "-0.05em",
                    filter: "drop-shadow(0 4px 0 rgba(76,0,128,0.35))",
                  }}
                >
                  V
                </span>
                {/* livro aberto abaixo */}
                <svg width="60" height="20" viewBox="0 0 60 20" fill="none" aria-hidden>
                  <path
                    d="M2 16 Q15 8 29 14 L29 6 Q15 0 2 8 Z"
                    fill="#ffffff"
                  />
                  <path
                    d="M58 16 Q45 8 31 14 L31 6 Q45 0 58 8 Z"
                    fill="#ffffff"
                  />
                  <line x1="30" y1="6" x2="30" y2="16" stroke="#ffffff" strokeWidth="2" />
                </svg>
              </div>
            </motion.div>

            {/* Wordmark "Verbete" */}
            <motion.h1
              initial={{ scale: 0.7, opacity: 0, y: -10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 180, damping: 14, delay: 0.1 }}
              className="relative mt-6 font-display font-black leading-none select-none"
              style={{
                fontSize: "clamp(56px, 16vw, 80px)",
                color: "#ffffff",
                WebkitTextStroke: "4px #4c1a8f",
                paintOrder: "stroke fill",
                filter:
                  "drop-shadow(0 6px 0 #4c1a8f) drop-shadow(0 12px 24px rgba(76,26,143,0.55))",
                letterSpacing: "-0.02em",
              }}
            >
              Verbete
            </motion.h1>

            {/* Tagline colorida */}
            <motion.p
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mt-4 font-display font-bold text-[15px]"
              style={{
                color: "#ffffff",
                textShadow: "0 2px 0 rgba(76,26,143,0.55), 0 4px 12px rgba(0,0,0,0.35)",
              }}
            >
              <span style={{ color: "#ffde00" }}>Blefe</span>,{" "}
              <span style={{ color: "#ff4bb0" }}>vote</span> e{" "}
              <span style={{ color: "#4dffcf" }}>descubra</span> palavras raras
            </motion.p>
          </div>

          {/* Ações */}
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="relative flex-1 flex flex-col px-6 pt-8 pb-4 gap-3.5 min-h-0"
          >
            {user && (
              <Suspense fallback={<div className="h-14" aria-hidden />}>
                <HomeStatsCard />
              </Suspense>
            )}

            {/* CTA primário — amarelo chunky 3D */}
            <motion.button
              whileTap={{ scale: 0.97, y: 4 }}
              onClick={() => setMode("host")}
              className="relative w-full py-5 rounded-[26px] font-display font-black text-2xl tracking-wide uppercase"
              style={{
                background: "linear-gradient(180deg, #fff17a 0%, #ffde00 55%, #f5c500 100%)",
                color: "#4c1a8f",
                border: "3px solid #ffffff",
                boxShadow:
                  "inset 0 3px 0 rgba(255,255,255,0.7), 0 8px 0 #b08a00, 0 16px 26px -6px rgba(255,222,0,0.55)",
                textShadow: "0 2px 0 rgba(255,255,255,0.4)",
              }}
            >
              🎉 Criar sala
            </motion.button>

            {/* CTA secundário — branco chunky 3D */}
            <motion.button
              whileTap={{ scale: 0.97, y: 4 }}
              onClick={() => setMode("join")}
              className="relative w-full py-5 rounded-[26px] font-display font-black text-2xl tracking-wide uppercase"
              style={{
                background: "linear-gradient(180deg, #ffffff 0%, #f3e9ff 100%)",
                color: "#4c1a8f",
                border: "3px solid #ffffff",
                boxShadow:
                  "inset 0 3px 0 rgba(255,255,255,0.9), 0 8px 0 #7c3aed, 0 16px 26px -6px rgba(124,58,237,0.5)",
              }}
            >
              🔑 Entrar com código
            </motion.button>

            {/* "Partida rápida" removida (2026-07-19): redundante com Criar
                sala. A RPC join_public_room segue no backend para uso futuro. */}

            {/* Trio de ações — glass card */}
            <div className="grid grid-cols-3 gap-3 mt-1">
              {[
                { label: "Como jogar", icon: "📚", onClick: () => setShowOnboarding(true) },
                { label: "Ranking", icon: "🏆", to: "/ranking" as const },
                { label: "Desafio", icon: "🎯", to: "/daily" as const, badge: "HOJE" },
              ].map((item) => {
                const inner = (
                  <div
                    className="relative w-full h-full flex flex-col items-center gap-1.5 py-3.5 rounded-2xl font-display font-bold text-white text-[13px]"
                    style={{
                      background: "rgba(255,255,255,0.14)",
                      backdropFilter: "blur(14px)",
                      WebkitBackdropFilter: "blur(14px)",
                      border: "1.5px solid rgba(255,255,255,0.35)",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 8px 20px -10px rgba(0,0,0,0.5)",
                    }}
                  >
                    <span className="text-2xl leading-none">{item.icon}</span>
                    <span>{item.label}</span>
                    {item.badge && (
                      <span
                        className="absolute -top-1.5 -right-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-black text-[#4c1a8f]"
                        style={{
                          background: "linear-gradient(180deg, #fff17a, #ffde00)",
                          border: "1.5px solid #ffffff",
                          boxShadow: "0 3px 8px rgba(255,222,0,0.6)",
                        }}
                      >
                        {item.badge}
                      </span>
                    )}
                  </div>
                );
                return item.to ? (
                  <Link key={item.label} to={item.to} preload="intent" className="active:scale-95 transition-transform">
                    {inner}
                  </Link>
                ) : (
                  <button key={item.label} onClick={item.onClick} className="active:scale-95 transition-transform">
                    {inner}
                  </button>
                );
              })}
            </div>

            {/* Entrar / Perfil */}
            {user ? (
              <Link
                to="/profile"
                className="flex items-center justify-center gap-2 py-3 rounded-2xl text-white text-[15px] font-display font-bold active:scale-[0.98] transition"
                style={{
                  background: "rgba(255,255,255,0.10)",
                  backdropFilter: "blur(12px)",
                  border: "1.5px solid rgba(255,255,255,0.3)",
                }}
              >
                👤 Perfil
              </Link>
            ) : (
              <Link
                to="/login"
                className="flex items-center justify-center gap-2 py-3 rounded-2xl text-white text-[15px] font-display font-bold active:scale-[0.98] transition"
                style={{
                  background: "rgba(255,255,255,0.10)",
                  backdropFilter: "blur(12px)",
                  border: "1.5px solid rgba(255,255,255,0.3)",
                }}
              >
                👤 Entrar
              </Link>
            )}

            {/* Estrela decorativa — canto inf esquerdo */}
            <motion.div
              aria-hidden
              className="absolute bottom-16 left-3 pointer-events-none"
              animate={{ y: [0, -8, 0], rotate: [-6, 6, -6] }}
              transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
            >
              <svg width="42" height="42" viewBox="0 0 42 42" fill="none">
                <path
                  d="M21 3 L26 15 L39 16 L29 25 L32 38 L21 31 L10 38 L13 25 L3 16 L16 15 Z"
                  fill="#ffde00"
                  stroke="#ffffff"
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                />
              </svg>
            </motion.div>

            {/* Coração decorativo — canto inf direito */}
            <motion.div
              aria-hidden
              className="absolute bottom-16 right-3 pointer-events-none"
              animate={{ y: [0, -8, 0], rotate: [8, -4, 8] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
            >
              <svg width="40" height="38" viewBox="0 0 40 38" fill="none">
                <path
                  d="M20 34 C 5 22 3 12 10 6 C 15 2 19 6 20 9 C 21 6 25 2 30 6 C 37 12 35 22 20 34 Z"
                  fill="#ff4bb0"
                  stroke="#ffffff"
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                />
              </svg>
            </motion.div>

            {/* Rodapé */}
            <div className="text-center mt-1">
              <p className="text-[12px] font-display font-bold" style={{ color: footerTextColor }}>
                4 a 12 jogadores · Mobile-first · Conta opcional
              </p>
            </div>
          </motion.div>
        </>
      ) : (

        <>
          <div className="text-center pt-3 pb-1">
            <motion.h1
              className="font-display text-stroke text-4xl"
              style={{
                background: "var(--gradient-fun)",
                WebkitBackgroundClip: "text",
                color: "transparent",
              }}
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 200 }}
            >
              Verbete
            </motion.h1>
          </div>

          <div className="flex-1 flex flex-col gap-2 mt-1 px-5">
            <motion.div
              key={mode}
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="flex flex-col gap-3"
            >
              <NicknameField value={nick} onChange={setNick} />
              <AvatarPicker
                avatar={avatar}
                color={color}
                onAvatar={setAvatar}
                onColor={setColor}
              />

              {mode === "join" && (
                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground font-display">
                    Código da sala
                  </label>
                  <input
                    inputMode="numeric"
                    maxLength={4}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="0000"
                    className="w-full bg-input rounded-2xl px-4 py-3 text-2xl font-display text-center tracking-[0.6em] border border-white/10 outline-none focus:ring-4 focus:ring-pink/40"
                  />
                </div>
              )}

              {error && (
                <p
                  role="alert"
                  aria-live="polite"
                  className="text-destructive text-sm text-center font-display"
                >
                  {error}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setMode("home")}
                  className="btn-pop bg-card flex-1 text-base py-3"
                >
                  ← Voltar
                </button>
                <button
                  onClick={mode === "host" ? handleHost : handleJoin}
                  disabled={busy}
                  className="btn-pop bg-gradient-fun text-white flex-[2] text-xl py-3 disabled:opacity-50"
                >
                  {busy ? "..." : mode === "host" ? "Criar! 🚀" : "Entrar"}
                </button>
              </div>
            </motion.div>
          </div>
        </>
      )}

      <div className="text-center text-[10px] text-muted-foreground py-2 px-5">
        <p className="flex justify-center gap-3">
          <Link to="/privacy" className="underline hover:text-foreground">
            Privacidade
          </Link>
          <span aria-hidden>·</span>
          <Link to="/terms" className="underline hover:text-foreground">
            Termos
          </Link>
        </p>
      </div>

      <AnimatePresence>
        {showOnboarding && (
          <Suspense fallback={null}>
            <Onboarding onClose={() => setShowOnboarding(false)} />
          </Suspense>
        )}
      </AnimatePresence>
    </div>
  );
}

function NicknameField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-muted-foreground font-display">Seu apelido</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ex: Bia, Zé, Dudu..."
        maxLength={14}
        className="w-full bg-input rounded-2xl px-4 py-3 text-lg font-display border border-white/10 outline-none focus:ring-4 focus:ring-pink/40"
      />
    </div>
  );
}

function AvatarPicker({
  avatar, color, onAvatar, onColor,
}: { avatar: string; color: string; onAvatar: (s: string) => void; onColor: (s: string) => void }) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-muted-foreground font-display">Avatar</label>
      <div className="rounded-2xl bg-card p-2 border border-white/10 shadow-soft">
        <div className="grid grid-cols-8 gap-1 mb-2">
          {AVATARS.map((a) => (
            <button key={a} onClick={() => onAvatar(a)}
              aria-label={`Escolher avatar ${a}`}
              aria-pressed={avatar === a}
              className={"text-2xl rounded-lg p-1 transition " + (avatar === a ? "bg-pink/30 ring-2 ring-pink" : "hover:bg-white/5")}>
              {a}
            </button>
          ))}
        </div>
        <div className="flex gap-1 justify-center">
          {COLORS.map((c) => (
            <button key={c} onClick={() => onColor(c)}
              aria-label={`Escolher cor ${c}`}
              aria-pressed={color === c}
              className="p-2 rounded-full transition active:scale-95"
            >
              <span
                className={"block w-6 h-6 rounded-full border-2 " + (color === c ? "border-white scale-110" : "border-black/40")}
                style={{ background: c }}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}




