import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.verbete.game",
  appName: "Verbete",
  // Bundle SPA offline gerado por `vite build --mode capacitor`
  webDir: "dist/client",
  // Para review da Apple, é mais seguro empacotar o bundle offline (sem server.url).
  // Para hot-reload em dev local, descomente o bloco `server` abaixo apontando
  // para a URL do seu dev server.
  // server: {
  //   url: "http://192.168.0.10:5173",
  //   cleartext: true,
  // },
  ios: {
    contentInset: "always",
    limitsNavigationsToAppBoundDomains: false,
    backgroundColor: "#fbf3e3",
  },
  android: {
    backgroundColor: "#fbf3e3",
    allowMixedContent: false,
    // Pinça no WebView (Rodada 2B): só as páginas de leitura a usam; as de
    // jogo seguem barradas pelo viewport (user-scalable=no) e pelo
    // touch-action — ver src/lib/viewport.ts.
    zoomEnabled: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: "#fbf3e3",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
      splashFullScreen: true,
      splashImmersive: true,
    },
    // Tema claro é o padrão (2026-10-21): ícones escuros na barra; o app
    // troca em tempo real quando o jogador escolhe o escuro (use-theme.ts).
    StatusBar: {
      style: "LIGHT",
      backgroundColor: "#fbf3e3",
      overlaysWebView: true,
    },
  },
};

export default config;
