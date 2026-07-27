// Fase 8: se o React quebrar, o jogador vê uma tela Verbete amigável em vez
// de tela branca — e o crash vira evento boundary_crash na telemetria.
import { Component, type ReactNode } from "react";
import { reportOpsEvent } from "@/lib/ops";
import { VerbeteTile, VerbeteWordmark } from "@/components/VerbeteLogo";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportOpsEvent("boundary_crash", {
      message: String(error?.message ?? error).slice(0, 300),
      stack: String(error?.stack ?? "").slice(0, 900),
      component_stack: String(info?.componentStack ?? "").slice(0, 500),
      route: typeof location !== "undefined" ? location.pathname : "",
    });
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-6 p-6 text-center">
        <VerbeteTile size={96} />
        <VerbeteWordmark size={44} />
        <div className="max-w-sm space-y-2">
          <h2 className="font-display text-2xl">Ops! Algo deu errado.</h2>
          <p className="text-muted-foreground">
            O problema já foi registrado. Recarregue para voltar ao jogo — se
            você estava numa sala, sua vaga continua lá.
          </p>
        </div>
        <button
          className="font-display font-bold rounded-2xl px-8 py-4 text-lg bg-primary text-primary-foreground shadow-lg active:translate-y-1 transition-transform"
          onClick={() => window.location.reload()}
        >
          🔄 Recarregar
        </button>
      </div>
    );
  }
}
