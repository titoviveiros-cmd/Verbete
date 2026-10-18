import { useEffect, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { Mascot } from "@/components/Mascot";
import {
  evaluateGate,
  fetchClientConfig,
  nativeBuildNumber,
  type Gate,
} from "@/lib/remote-config";

const NATIVE_BUILD = nativeBuildNumber(
  import.meta.env.VITE_NATIVE_VERSION_CODE,
);

// Bloqueio remoto: só aparece quando ligado em app_config (versão mínima do
// APK ou manutenção). Mesmo padrão visual da tela "Acesso restrito".
export function RemoteGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ kind: "ok" });

  useEffect(() => {
    let alive = true;
    let last = 0;
    const check = async () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      const cfg = await fetchClientConfig();
      if (!alive) return;
      setGate(
        evaluateGate(cfg, {
          native: Capacitor.isNativePlatform(),
          nativeBuild: NATIVE_BUILD,
        }),
      );
    };
    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (gate.kind === "ok") return <>{children}</>;

  return (
    <div
      className="mobile-shell items-center justify-center gap-3"
      role="alert"
    >
      <Mascot mood={gate.kind === "update" ? "excited" : "thinking"} />
      <h1 className="font-display text-2xl text-center">
        {gate.kind === "update" ? "Atualize o Verbete" : "Voltamos já!"}
      </h1>
      <p className="text-sm text-muted-foreground text-center max-w-xs">
        {gate.kind === "update"
          ? "Esta versão do app saiu de circulação. Baixe a atualização para continuar jogando."
          : gate.message}
      </p>
      {gate.kind === "update" && (
        <a
          href={gate.storeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-pop bg-gradient-fun text-white text-sm"
        >
          Atualizar agora
        </a>
      )}
    </div>
  );
}
