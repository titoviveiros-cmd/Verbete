import { APP_URL } from "@/lib/app-url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import { useEffect } from "react";
import appCss from "../styles.css?url";
import { installAudioUnlock, playUITap, vibrate } from "@/lib/sound";
import { ensureAnonSession } from "@/lib/auth-session";
import { AchievementToaster } from "@/components/AchievementToaster";
import { OfflineBanner } from "@/components/OfflineBanner";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content" },
      { name: "theme-color", content: "#fbf3e3", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#1a0f2e" },
      { name: "color-scheme", content: "dark" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: "Verbete" },
      { title: "Verbete — Ganhar conhecimento nunca foi tão divertido!" },
      { name: "description", content: "Ganhar conhecimento nunca foi tão divertido! Multiplayer em tempo real para 4 a 12 amigos. Blefe, vote e descubra significados raros do português." },
      { name: "author", content: "Verbete" },
      { property: "og:title", content: "Verbete — Ganhar conhecimento nunca foi tão divertido!" },
      { property: "og:description", content: "Ganhar conhecimento nunca foi tão divertido! Multiplayer em tempo real para 4 a 12 amigos. Blefe, vote e descubra significados raros do português." },
      { property: "og:type", content: "website" },
      
      { name: "twitter:title", content: "Verbete — Ganhar conhecimento nunca foi tão divertido!" },
      { name: "twitter:description", content: "Ganhar conhecimento nunca foi tão divertido! Multiplayer em tempo real para 4 a 12 amigos. Blefe, vote e descubra significados raros do português." },
      { property: "og:image", content: `${APP_URL}/og-verbete.jpg` },
      { property: "og:image:secure_url", content: `${APP_URL}/og-verbete.jpg` },
      { property: "og:image:type", content: "image/jpeg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Verbete — jogo multiplayer de blefe com palavras raras do português" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: `${APP_URL}/og-verbete.jpg` },
      { name: "twitter:image:alt", content: "Verbete — jogo multiplayer de blefe com palavras raras do português" },
      { property: "og:site_name", content: "Verbete" },
      { property: "og:locale", content: "pt_BR" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      // Preload do CSS de fontes para que o browser comece a baixar Fredoka/Baloo
      // antes de o parser chegar no <link rel="stylesheet">. Isso elimina o
      // flash de fallback (system-ui) no primeiro paint em conexões 3G/4G.
      {
        rel: "preload",
        as: "style",
        href: "https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Baloo+2:wght@500;700&display=swap",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Baloo+2:wght@500;700&display=swap",
      },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "Verbete",
          url: `${APP_URL}`,
          description: "Jogo multiplayer em tempo real de blefe com palavras raras do português.",
          inLanguage: "pt-BR",
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Game",
          name: "Verbete",
          url: `${APP_URL}`,
          genre: "Party / Word game",
          numberOfPlayers: "4-12",
          inLanguage: "pt-BR",
        }),
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" style={{ colorScheme: "dark" }}>
      <head>
        <HeadContent />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[10000] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          Pular para o conteúdo
        </a>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  useEffect(() => { installAudioUnlock(); }, []);
  // S4: abre a sessão anônima já no boot para que o primeiro join/create
  // saia com auth.uid() e a identidade seja reivindicada de imediato.
  useEffect(() => { void ensureAnonSession(); }, []);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const btn = target.closest("button, [role='button']") as HTMLElement | null;
      if (!btn) return;
      if (btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true") return;
      if (btn.closest("[data-no-sound]")) return;
      void playUITap();
      // Haptic feedback global — pulso curtinho em qualquer botão.
      vibrate(8);
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  // Anti-trapaça: bloquear colar/arrastar em campos de texto do jogo
  useEffect(() => {
    const block = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      const editable = (t as HTMLElement).isContentEditable;
      if (tag === "INPUT" || tag === "TEXTAREA" || editable) {
        e.preventDefault();
      }
    };
    document.addEventListener("paste", block, true);
    document.addEventListener("drop", block, true);
    return () => {
      document.removeEventListener("paste", block, true);
      document.removeEventListener("drop", block, true);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <OfflineBanner />
      <main id="main">
        <Outlet />
      </main>
      <AchievementToaster />
      <Toaster position="top-center" richColors closeButton />
    </QueryClientProvider>
  );
}


