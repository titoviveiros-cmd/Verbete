import { defineConfig, devices } from "@playwright/test";

// E2E do Verbete — roda contra o dev server (localhost:5173).
// Local: usa o Supabase do .env (salas de teste são efêmeras;
// cleanup_zombie_rooms varre depois). No CI, apontará para o
// Supabase local via VITE_* antes do build/preview.
// E2E_BASE_URL aponta a suíte para um deploy (ex.: produção no Cloudflare)
// em vez do dev server local — smoke pós-deploy sem subir nada.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    viewport: { width: 390, height: 844 }, // mobile portrait — formato do jogo
    trace: "retain-on-failure",
    // E2E_RESOLVE="MAP host ip" contorna cache DNS local ao testar um
    // deploy recém-criado (o DNS global já resolve, o resolvedor local não).
    ...(process.env.E2E_RESOLVE
      ? {
          launchOptions: {
            args: [`--host-resolver-rules=${process.env.E2E_RESOLVE}`],
          },
        }
      : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: "npm run dev",
          url: "http://localhost:5173",
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});
