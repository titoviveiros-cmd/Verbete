import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import react from "@vitejs/plugin-react";

// Config independente do vite.config (que carrega o plugin do TanStack Start,
// desnecessário e frágil em ambiente de teste).
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    env: {
      // O client do Supabase é um Proxy preguiçoso — só instancia no primeiro
      // acesso — mas se um teste tocar nele, não pode explodir por falta de env.
      VITE_SUPABASE_URL: "http://supabase.test.local",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    },
  },
});
