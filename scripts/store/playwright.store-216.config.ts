// Screenshots da ficha da Play Store (tema CLARO), fora das suítes do CI:
//   npx playwright test -c scripts/store/playwright.store-216.config.ts
// App local (dev server) + Supabase SIMULADO (e2e/visual/supabase-mock):
// nada sai da máquina — o gerador antigo (scripts/gen-store-shots.mjs)
// jogava contra a produção e criava salas reais.
import { defineConfig } from "@playwright/test";
import {
  TERMS_STORAGE_KEY,
  TERMS_VERSION,
  serializeTermsRecord,
  withAcceptance,
} from "../../src/lib/terms-record";
import { ageDeclarationStorageEntry } from "../../src/lib/age-record";

const baseURL = "http://localhost:5173";
const accepted = { version: TERMS_VERSION, at: "2026-10-26T00:00:00.000Z" };
const termsRecord = serializeTermsRecord(
  [
    "00000000-0000-4000-8000-0000000000aa", // supabase-mock: sessão do boot
    "00000000-0000-4000-8000-00000000b1a0", // fixtures USER_ID: conta logada
  ].reduce((rec, uid) => withAcceptance(rec, uid, accepted), { ids: {}, legacy: null }),
);

export default defineConfig({
  testDir: ".",
  testMatch: /store-shots-216\.spec\.ts$/,
  timeout: 90_000,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    // 432×768 @2,5 = 1080×1920 (9:16 exato, dentro do limite 2:1 da Play)
    viewport: { width: 432, height: 768 },
    deviceScaleFactor: 2.5,
    isMobile: true,
    hasTouch: true,
    storageState: {
      cookies: [],
      // + declaração de idade (ECA Digital B5, 11/11/2026): adulto, como no playwright.config.ts
      origins: [
        {
          origin: baseURL,
          localStorage: [{ name: TERMS_STORAGE_KEY, value: termsRecord }, ageDeclarationStorageEntry(1990)],
        },
      ],
    },
  },
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    // Mesmo alvo simulado do job e2e-visual do CI: o .env local (produção)
    // é sobreposto — variáveis do processo vencem as do arquivo no Vite.
    env: {
      VITE_SUPABASE_URL: "http://127.0.0.1:54321",
      VITE_SUPABASE_PUBLISHABLE_KEY: "e2e-visual-mock",
    },
  },
});
