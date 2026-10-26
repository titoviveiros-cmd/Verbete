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
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  // Serial: o full-round já usa 2 páginas; smoke em paralelo disputava o
  // dev server e flakava na hidratação da home.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // timing-reporter: tabela de tempo por spec/teste no fim (só mede).
  reporter: [
    [process.env.CI ? "github" : "list"],
    ["./e2e/timing-reporter.ts"],
  ],
  use: {
    baseURL,
    viewport: { width: 390, height: 844 }, // mobile portrait — formato do jogo
    trace: "retain-on-failure",
    // Nenhuma ação pode pendurar até o timeout do teste: em telas que
    // transicionam ao vivo (fases do jogo), fill/click sem teto ficavam
    // presos em actionability enquanto o jogo expulsava o jogador parado.
    actionTimeout: 10_000,
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
  // Grupos com o MESMO dispositivo e as mesmas regras (workers, retries):
  // - visual-screens / visual: e2e/visual — Supabase SIMULADO no navegador
  //   (installSupabaseMock intercepta toda chamada e aborta o desconhecido);
  //   dispensam o Supabase local e rodam em 2 máquinas no job `e2e-visual`.
  //   O screens (47 testes, ~4,5 min) fica sozinho: o shard nativo reparte
  //   por contagem com o arquivo inteiro num shard só e deixava 79 × 29
  //   testes (10m10s × 1m58s). Spec novo em e2e/visual cai no `visual`;
  // - stateful: o resto — backend real (salas, multiplayer) e os specs de
  //   produção (pulados sem E2E_BASE_URL); job `integration`.
  // Sem --project roda tudo (135 testes), como antes.
  projects: [
    {
      name: "visual-screens",
      testMatch: /[\\/]e2e[\\/]visual[\\/]screens\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "visual",
      testMatch: /[\\/]e2e[\\/]visual[\\/].*\.spec\.ts$/,
      testIgnore: /[\\/]e2e[\\/]visual[\\/]screens\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "stateful",
      testIgnore: /[\\/]e2e[\\/]visual[\\/]/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
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
