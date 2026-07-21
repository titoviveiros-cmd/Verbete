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

  // OAuth Google/Apple: botões ocultos até os providers serem configurados
  // no Supabase (Authentication → Providers) — reintroduzir handleOAuth aqui.

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

      {/* Google/Apple OCULTOS até os providers OAuth serem configurados no
          Supabase (playtest 2026-07-21: "Unsupported provider" ao tocar).
          Reativar quando Authentication → Providers tiver as credenciais. */}

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
