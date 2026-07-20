import { defineConfig, devices } from "@playwright/test";

// E2E do Verbete — roda contra o dev server (localhost:5173).
// Local: usa o Supabase do .env (salas de teste são efêmeras;
// cleanup_zombie_rooms varre depois). No CI, apontará para o
// Supabase local via VITE_* antes do build/preview.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 390, height: 844 }, // mobile portrait — formato do jogo
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
