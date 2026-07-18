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
    backgroundColor: "#0f0a1f",
  },
  android: {
    backgroundColor: "#0f0a1f",
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: "#0f0a1f",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0f0a1f",
      overlaysWebView: true,
    },
  },
};

export default config;


