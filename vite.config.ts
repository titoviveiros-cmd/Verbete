// Config Vite standalone (substitui o wrapper @lovable.dev/vite-tanstack-config).
// Todos os plugins abaixo já eram dependências diretas do projeto — o wrapper
// só os compunha. Ordem importa: tsconfig paths e tailwind antes do Start.
//
// Modos de build:
//   vite build                    -> web SSR (deploy Cloudflare via wrangler)
//   vite build --mode capacitor   -> SPA shell offline (bundle dos apps
//                                    nativos; gera index.html em dist/client,
//                                    que é o webDir do Capacitor)
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ mode }) => {
  // O prerender do shell SPA relança um vite preview que RECARREGA este
  // config sem repassar --mode capacitor. Persistimos a decisão numa env
  // (mesmo processo) para o reload interno manter os mesmos plugins —
  // sem isso o plugin do Cloudflare entraria no preview e o derrubaria.
  if (mode === "capacitor") process.env.CAP_BUILD = "1";
  const isCapacitor = mode === "capacitor" || process.env.CAP_BUILD === "1";
  const isProd = process.env.NODE_ENV === "production";
  return {
    plugins: [
      tsConfigPaths(),
      tailwindcss(),
      // Cloudflare só no build web de produção; nunca no bundle nativo.
      ...(isProd && !isCapacitor
        ? [cloudflare({ viteEnvironment: { name: "ssr" } })]
        : []),
      tanstackStart({
        // Entry SSR customizado (src/server.ts embrulha o handler com captura de erros)
        server: { entry: "server" },
        ...(isCapacitor
          ? { spa: { enabled: true, prerender: { outputPath: "/index.html" } } }
          : {}),
      }),
      viteReact(),
    ],
    resolve: {
      dedupe: [
        "react",
        "react-dom",
        "@tanstack/react-router",
        "@tanstack/react-query",
      ],
    },
    // Fase 7 (perf): vendors estáveis em chunks próprios SÓ no client — como
    // cada deploy troca o hash do bundle e o auto-update força reload, sem o
    // split o jogador rebaixa ~230KB gz a cada deploy; com ele, só o código do
    // app muda. O SSR (worker) mantém o chunking automático.
    environments: {
      client: {
        build: {
          rollupOptions: {
            output: {
              manualChunks(id: string) {
                if (!id.includes("node_modules")) return undefined;
                if (
                  /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(
                    id,
                  )
                )
                  return "vendor-react";
                if (
                  /[\\/]node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(
                    id,
                  )
                )
                  return "vendor-motion";
                if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id))
                  return "vendor-supabase";
                if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id))
                  return "vendor-tanstack";
                return undefined;
              },
            },
          },
        },
      },
    },
  };
});
