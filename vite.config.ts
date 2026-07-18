// Config Vite standalone (substitui o wrapper @lovable.dev/vite-tanstack-config).
// Todos os plugins abaixo já eram dependências diretas do projeto — o wrapper
// só os compunha. Ordem importa: tsconfig paths e tailwind antes do Start;
// o plugin react vem por último (customViteReactPlugin) como o Start exige.
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    tsConfigPaths(),
    tailwindcss(),
    // Só entra no build de produção (deploy Cloudflare via wrangler.jsonc);
    // em dev o servidor do próprio Start responde.
    ...(process.env.NODE_ENV === "production" ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
    tanstackStart({
      // Entry SSR customizado (src/server.ts embrulha o handler com captura de erros)
      server: { entry: "server" },
    }),
    viteReact(),
  ],
  resolve: {
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"],
  },
});
