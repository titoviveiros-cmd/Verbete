import { APP_URL } from "@/lib/app-url";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { randomAvatar, randomColor } from "@/lib/avatars";
import { AvatarGrid } from "@/components/AvatarGrid";
import { sanitizeNickname } from "@/lib/text-filter";
import { getPlayerId, getStored, setStored } from "@/lib/player-id";
import { createRoom, joinRoom } from "@/lib/room";
import { friendlyEntryError } from "@/lib/entry-errors";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SoundToggle } from "@/components/SoundToggle";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { VerbeteTile, verbeteWordmarkStyle } from "@/components/VerbeteLogo";
import { Mascot } from "@/components/Mascot";

// Carregados sob demanda: nenhum aparece no bundle inicial da home.
const Onboarding = lazy(() =>
  import("@/components/Onboarding").then((m) => ({ default: m.Onboarding })),
);
const HomeStatsCard = lazy(() =>
  import("@/components/HomeStatsCard").then((m) => ({
    default: m.HomeStatsCard,
  })),
);

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Verbete — blefe com palavras raras" },
      {
        name: "description",
        content:
          "Invente significados para palavras raras, engane seus amigos e descubra a verdade. Multiplayer em tempo real, de 4 a 12 jogadores, direto no navegador.",
      },
      {
        property: "og:title",
        content: "Verbete — blefe com palavras raras",
      },
      {
        property: "og:description",
        content:
          "Invente significados, engane os amigos e descubra a verdade. De 4 a 12 jogadores.",
      },
      { property: "og:url", content: `${APP_URL}/` },
    ],
    links: [{ rel: "canonical", href: `${APP_URL}/` }],
  }),
  component: HomePage,
});

// Partículas da Home: letras de dicionário flutuando devagar (identidade de
// jogo de palavras) — no lugar dos confetes coloridos.
const GLYPHS = [
  { ch: "A", l: "7%", t: "13%", s: 22, c: "var(--c-gold)", d: 0 },
  { ch: "?", l: "86%", t: "9%", s: 26, c: "var(--c-turq)", d: 0.8 },
  { ch: "Ç", l: "12%", t: "44%", s: 18, c: "var(--c-violet)", d: 1.4 },
  { ch: "B", l: "90%", t: "38%", s: 20, c: "var(--c-magenta)", d: 0.4 },
  { ch: "é", l: "4%", t: "74%", s: 20, c: "var(--c-turq)", d: 2 },
  { ch: "!", l: "93%", t: "70%", s: 22, c: "var(--c-gold)", d: 1.1 },
  { ch: "C", l: "48%", t: "4%", s: 16, c: "var(--c-violet)", d: 2.6 },
];

function HomePage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };
  const [mode, setMode] = useState<"home" | "host" | "join">("home");
  const [nick, setNick] = useState<string>(() => getStored("nick", ""));
  const [avatar, setAvatar] = useState<string>(() =>
    getStored("avatar", randomAvatar()),
  );
  // Cor sem seletor na tela (playtest 2026-10-22): a salva é preservada e o
  // jogador novo ganha uma aleatória — segue usada no anel do avatar etc.
  const [color] = useState<string>(() => getStored("color", randomColor()));
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
    if (!cleanNick || cleanNick === "Anônimo") {
      setError("Escolha um apelido");
      return;
    }
    setBusy(true);
    try {
      persist();
      const room = await createRoom(playerId, cleanNick, avatar, color);
      // Marca este jogador como criador desta sala — usado para restaurar
      // identidade de host caso o /room/$code seja aberto em outra aba/sessão.
      // room.host_id (e não playerId): createRoom pode ter regenerado o id
      // local se o antigo pertencia a outra identidade (player_id_taken).
      setStored("hosted:" + room.code, room.host_id ?? playerId);
      nav({ to: "/room/$code", params: { code: room.code } });
    } catch (e) {
      console.error("create room failed", e);
      setError(friendlyEntryError(e, "create"));
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    setError(null);
    const cleanNick = sanitizeNickname(nick);
    if (!cleanNick || cleanNick === "Anônimo") {
      setError("Escolha um apelido");
      return;
    }
    if (code.length !== 4) {
      setError("Código de 4 dígitos");
      return;
    }
    setBusy(true);
    try {
      persist();
      const room = await joinRoom(code, playerId, cleanNick, avatar, color);
      nav({ to: "/room/$code", params: { code: room.code } });
    } catch (e) {
      console.error("join room failed", e);
      setError(friendlyEntryError(e, "join"));
    } finally {
      setBusy(false);
    }
  };

  const isHome = mode === "home";

  return (
    <div className="mobile-shell stage-wide relative overflow-hidden">
      {/* Noite do Verbete: brilho neon atrás da marca + letras flutuando */}
      <div
        className="absolute inset-0 overflow-hidden pointer-events-none"
        aria-hidden
        style={{ zIndex: 0 }}
      >
        <div
          className="absolute left-1/2 lg:left-[30%] -translate-x-1/2 rounded-full"
          style={{
            top: "calc(env(safe-area-inset-top, 0px) + 10px)",
            width: 520,
            height: 520,
            background:
              "radial-gradient(circle, rgb(255 63 174 / 0.34) 0%, rgb(155 108 255 / 0.18) 38%, transparent 70%)",
            filter: "blur(30px)",
          }}
        />
        {GLYPHS.map((g, i) => (
          <motion.span
            key={i}
            className="absolute font-display font-bold select-none"
            style={{
              left: g.l,
              top: g.t,
              fontSize: g.s,
              color: g.c,
              opacity: 0.28,
              textShadow: `0 0 12px ${g.c}`,
            }}
            animate={{ y: [0, -10, 0], rotate: [-6, 6, -6] }}
            transition={{
              duration: 5 + i * 0.4,
              repeat: Infinity,
              ease: "easeInOut",
              delay: g.d,
            }}
          >
            {g.ch}
          </motion.span>
        ))}
      </div>

      {/* Controles do topo (som / tema) */}
      <div
        className="absolute z-30"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 12px)",
          left: "calc(env(safe-area-inset-left, 0px) + 12px)",
        }}
      >
        <SoundToggle className="!w-11 !h-11 !text-base" />
      </div>
      <div
        className="absolute z-30"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 12px)",
          right: "calc(env(safe-area-inset-right, 0px) + 12px)",
        }}
      >
        <ThemeToggle className="!w-11 !h-11 !text-base !opacity-100" />
      </div>

      <div className="relative z-10 flex-1 lg:min-h-0 flex flex-col lg:grid lg:grid-cols-[1.1fr_0.9fr] lg:gap-12 lg:items-center">
        {/* Herói — tile V + Livro Mascote + wordmark + tagline */}
        <div
          className={
            "relative flex flex-col items-center text-center px-6 " +
            (isHome
              ? "pt-[calc(env(safe-area-inset-top,0px)+64px)]"
              : "pt-[calc(env(safe-area-inset-top,0px)+56px)] max-lg:hidden") +
            " lg:pt-0"
          }
        >
          <div className="relative">
            <motion.div
              aria-hidden
              className="absolute -inset-6 rounded-[40px] pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle, rgb(255 63 174 / 0.55) 0%, transparent 70%)",
                filter: "blur(22px)",
              }}
              animate={{ scale: [1, 1.08, 1], opacity: [0.75, 1, 0.75] }}
              transition={{
                duration: 3.2,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
            <motion.div
              initial={{ scale: 0.6, opacity: 0, rotate: -6 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 180, damping: 14 }}
              className="relative"
            >
              <VerbeteTile size={isHome ? 118 : 96} />
            </motion.div>
            {/* O Livro espia ao lado da marca — presença viva, não protagonista */}
            <motion.div
              className="absolute -right-[74px] -bottom-3 lg:-right-[118px] lg:-bottom-6"
              initial={{ x: -12, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.45, type: "spring", stiffness: 160 }}
            >
              <div className="lg:hidden">
                <Mascot mood="idle" size={74} />
              </div>
              <div className="hidden lg:block">
                <Mascot mood="idle" size={120} />
              </div>
            </motion.div>
          </div>

          <motion.h1
            initial={{ scale: 0.7, opacity: 0, y: -10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{
              type: "spring",
              stiffness: 180,
              damping: 14,
              delay: 0.1,
            }}
            className="relative mt-5 lg:mt-7 font-display font-black leading-none select-none"
            style={verbeteWordmarkStyle(
              isHome ? "clamp(56px, 16vw, 96px)" : "clamp(48px, 13vw, 84px)",
            )}
          >
            Verbete
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="mt-3 font-display font-bold text-[16px] lg:text-[22px] text-foreground"
            style={{ textShadow: "0 2px 12px rgb(0 0 0 / 0.35)" }}
          >
            <span className="text-sun">Blefe</span>,{" "}
            <span className="text-pink">vote</span> e{" "}
            <span className="text-mint">descubra</span> palavras raras
          </motion.p>

          {/* Desktop: o jogo em 3 passos, como peças da coleção */}
          <motion.ol
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 }}
            className="hidden lg:grid grid-cols-3 gap-3 mt-10 w-full max-w-[560px]"
          >
            {[
              {
                n: "1",
                t: "Invente",
                d: "um significado convincente",
                c: "text-sun",
              },
              {
                n: "2",
                t: "Engane",
                d: "os amigos na votação",
                c: "text-pink",
              },
              {
                n: "3",
                t: "Descubra",
                d: "qual era a verdade",
                c: "text-mint",
              },
            ].map((s) => (
              <li key={s.n} className="sticker !p-3 text-left">
                <span className={"font-display text-2xl leading-none " + s.c}>
                  {s.n}
                </span>
                <p className="font-display text-lg leading-tight mt-1">{s.t}</p>
                <p className="text-xs text-muted-foreground leading-snug">
                  {s.d}
                </p>
              </li>
            ))}
          </motion.ol>
        </div>

        {/* Coluna de ações (celular: abaixo do herói; desktop: painel à direita) */}
        {isHome ? (
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="relative flex-1 lg:flex-none flex flex-col px-6 pt-7 pb-3 gap-3.5 min-h-0 lg:panel lg:p-7 lg:gap-4"
          >
            {user && (
              <Suspense fallback={<div className="h-14" aria-hidden />}>
                <HomeStatsCard />
              </Suspense>
            )}

            {/* CTA principal — candy ouro da coleção */}
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => setMode("host")}
              className="btn-pop btn-gold w-full py-5 text-2xl uppercase tracking-wide"
            >
              🎉 Criar sala
            </motion.button>

            {/* CTA secundário — candy violeta */}
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => setMode("join")}
              className="btn-pop btn-violet w-full py-4 !px-3 text-xl max-[389px]:text-lg uppercase tracking-wide whitespace-nowrap"
            >
              🔑 Entrar com código
            </motion.button>

            {/* "Partida rápida" removida (2026-07-19): redundante com Criar
                sala. A RPC join_public_room segue no backend para uso futuro. */}

            {/* Trio de ações — vidro, claramente abaixo das ações de jogo */}
            <div className="grid grid-cols-3 gap-3 mt-1">
              {[
                {
                  label: "Como jogar",
                  icon: "📚",
                  onClick: () => setShowOnboarding(true),
                },
                { label: "Ranking", icon: "🏆", to: "/ranking" as const },
                {
                  label: "Desafio",
                  icon: "🎯",
                  to: "/daily" as const,
                  badge: "HOJE",
                },
              ].map((item) => {
                const inner = (
                  <div className="glass-tile relative w-full h-full flex flex-col items-center gap-1.5 py-3.5 rounded-2xl font-display font-bold text-[13px]">
                    <span className="text-2xl leading-none">{item.icon}</span>
                    <span>{item.label}</span>
                    {item.badge && (
                      <span className="absolute -top-2 -right-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-black btn-gold !shadow-none border !border-white">
                        {item.badge}
                      </span>
                    )}
                  </div>
                );
                return item.to ? (
                  <Link
                    key={item.label}
                    to={item.to}
                    preload="intent"
                    className="active:scale-95 transition-transform"
                  >
                    {inner}
                  </Link>
                ) : (
                  <button
                    key={item.label}
                    onClick={item.onClick}
                    className="active:scale-95 transition-transform"
                  >
                    {inner}
                  </button>
                );
              })}
            </div>

            {/* Entrar / Perfil */}
            {user ? (
              <Link
                to="/profile"
                className="glass-tile flex items-center justify-center gap-2 py-3 rounded-2xl text-[15px] font-display font-bold active:scale-[0.98] transition"
              >
                👤 Perfil
              </Link>
            ) : (
              <Link
                to="/login"
                className="glass-tile flex items-center justify-center gap-2 py-3 rounded-2xl text-[15px] font-display font-bold active:scale-[0.98] transition"
              >
                👤 Entrar
              </Link>
            )}

            {/* Rodapé — sem a versão do build: ela fica na meta verbete-build
                do HTML e no painel /admin/ops (área técnica). */}
            <div className="text-center mt-1">
              <p className="text-[12px] font-bold text-muted-foreground">
                4 a 12 jogadores · Conta opcional
              </p>
            </div>
          </motion.div>
        ) : (
          <div className="relative flex-1 lg:flex-none flex flex-col min-h-0">
            {/* Celular: marca compacta no topo do formulário */}
            <div className="text-center pt-3 pb-1 lg:hidden">
              <motion.h1
                className="font-display font-black leading-none select-none inline-block"
                style={verbeteWordmarkStyle(40)}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 200 }}
              >
                Verbete
              </motion.h1>
            </div>

            <motion.div
              key={mode}
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="flex flex-col gap-3 mt-1 px-5 lg:px-7 lg:py-7 lg:panel"
            >
              <p className="eyebrow text-center">
                {mode === "host" ? "Nova sala" : "Entrar numa sala"}
              </p>
              <NicknameField value={nick} onChange={setNick} />
              <AvatarPicker avatar={avatar} onAvatar={setAvatar} />

              {mode === "join" && (
                <div>
                  <label
                    htmlFor="room-code"
                    className="eyebrow block mb-1.5 px-1"
                  >
                    Código da sala
                  </label>
                  <input
                    id="room-code"
                    inputMode="numeric"
                    maxLength={4}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="0000"
                    className="field w-full px-4 py-3 text-3xl font-display text-center tracking-[0.6em]"
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

              <div className="flex gap-2.5 pt-1">
                <button
                  onClick={() => setMode("home")}
                  className="btn-pop btn-plain flex-1 text-base py-3"
                >
                  ← Voltar
                </button>
                <button
                  onClick={mode === "host" ? handleHost : handleJoin}
                  disabled={busy}
                  className="btn-pop btn-gold flex-[2] text-xl py-3"
                >
                  {busy ? "..." : mode === "host" ? "Criar! 🚀" : "Entrar"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </div>

      <div className="relative z-10 text-center text-[11px] text-muted-foreground py-2 px-5">
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

function NicknameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <div>
      <label htmlFor="nickname" className="eyebrow block mb-1.5 px-1">
        Seu apelido
      </label>
      <input
        id="nickname"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ex: Bia, Zé, Dudu..."
        maxLength={14}
        className="field w-full px-4 py-3 text-lg font-display"
      />
    </div>
  );
}

function AvatarPicker({
  avatar,
  onAvatar,
}: {
  avatar: string;
  onAvatar: (s: string) => void;
}) {
  return (
    <div>
      <p className="eyebrow mb-1.5 px-1">Avatar</p>
      <div className="sticker !p-2.5">
        <AvatarGrid value={avatar} onChange={onAvatar} />
      </div>
    </div>
  );
}
