import { APP_URL } from "@/lib/app-url";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Mascot } from "@/components/Mascot";
import { verbeteWordmarkStyle } from "@/components/VerbeteLogo";
import { motion } from "framer-motion";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Entrar — Verbete" },
      {
        name: "description",
        content:
          "Entre na sua conta Verbete para acompanhar seu ranking e histórico de partidas.",
      },
      { property: "og:title", content: "Entrar — Verbete" },
      { property: "og:description", content: "Acesse sua conta Verbete." },
      { property: "og:url", content: `${APP_URL}/login` },
      { name: "robots", content: "noindex,follow" },
    ],
    links: [{ rel: "canonical", href: `${APP_URL}/login` }],
  }),
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    // Sessão ANÔNIMA não conta como logado (S4: todo jogador tem uma) —
    // sem esta checagem o /login redirecionava direto para o perfil e o
    // formulário de e-mail ficava inalcançável.
    if (user && !(user as { is_anonymous?: boolean }).is_anonymous)
      nav({ to: "/profile" });
  }, [user]);

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { display_name: displayName || email.split("@")[0] },
          },
        });
        if (error) throw error;
        setInfo("Confira seu email para confirmar a conta.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // OAuth Google ATIVO (2026-08-02: provider configurado no Supabase via
  // Management API; client validado contra o Google). Apple continua oculto
  // até existir conta Apple Developer.
  const handleGoogle = async () => {
    setError(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
      // O navegador navega para o Google — sem reset de busy aqui.
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mobile-shell items-center pt-8 gap-4">
      <Mascot mood="excited" size={120} />
      {/* Fase 3/uniformização: título no tratamento canônico da marca
          (a variante gradiente + stroke renderizava quebrada — playtest). */}
      <motion.h1
        className="font-display font-black leading-none"
        style={verbeteWordmarkStyle(44)}
        initial={{ scale: 0.6, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 200, damping: 14 }}
      >
        {mode === "signin" ? "Entrar" : "Criar conta"}
      </motion.h1>
      <p className="text-sm text-muted-foreground text-center px-4">
        Tenha seu ranking e histórico de partidas. Continua opcional jogar sem
        conta.
      </p>

      <button
        onClick={handleGoogle}
        disabled={busy}
        className="w-full max-w-sm flex items-center justify-center gap-3 bg-white text-[#1f1f1f] font-display font-bold rounded-2xl px-4 py-3 border border-white/10 shadow-lg active:translate-y-0.5 transition-transform disabled:opacity-50"
      >
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
          <path
            fill="#EA4335"
            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          />
          <path
            fill="#4285F4"
            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          />
          <path
            fill="#FBBC05"
            d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
          />
          <path
            fill="#34A853"
            d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          />
        </svg>
        Entrar com Google
      </button>

      <div className="flex items-center gap-3 w-full max-w-sm">
        <div className="flex-1 h-px bg-white/10" />
        <span className="text-xs text-muted-foreground font-display">
          ou com email
        </span>
        <div className="flex-1 h-px bg-white/10" />
      </div>

      {/* Apple OCULTO até existir conta Apple Developer (US$ 99/ano). */}

      <form
        onSubmit={handleEmail}
        className="flex flex-col gap-3 w-full max-w-sm"
      >
        {mode === "signup" && (
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Nome de exibição"
            maxLength={24}
            className="bg-input rounded-2xl px-4 py-3 font-display border border-white/10 outline-none focus:ring-4 focus:ring-pink/40"
          />
        )}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          required
          className="bg-input rounded-2xl px-4 py-3 font-display border border-white/10 outline-none focus:ring-4 focus:ring-pink/40"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Senha"
          required
          minLength={6}
          className="bg-input rounded-2xl px-4 py-3 font-display border border-white/10 outline-none focus:ring-4 focus:ring-pink/40"
        />
        {error && (
          <p className="text-destructive text-sm text-center">{error}</p>
        )}
        {info && <p className="text-primary text-sm text-center">{info}</p>}
        <button
          disabled={busy}
          type="submit"
          className="btn-pop bg-gradient-fun text-white text-lg disabled:opacity-50"
        >
          {busy ? "..." : mode === "signin" ? "Entrar" : "Criar conta"}
        </button>
      </form>

      <button
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        className="text-sm text-muted-foreground underline"
      >
        {mode === "signin"
          ? "Não tem conta? Cadastre-se"
          : "Já tem conta? Entrar"}
      </button>

      <Link to="/" className="text-sm text-muted-foreground mt-2">
        ← Voltar
      </Link>
    </div>
  );
}
