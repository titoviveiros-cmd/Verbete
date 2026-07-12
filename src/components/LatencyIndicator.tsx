// Indicador de latência da sala — mede round-trip via WebSocket Realtime
// (broadcast com ack) na conexão já aberta pelo Supabase Realtime. Evita
// handshake TLS de cada request HTTP e tipicamente reduz 50–100ms.
// Pausa quando a aba está em background para não competir com o jogo.
// Verde <250ms, amarelo <600ms, vermelho >600ms ou erro.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

export function LatencyIndicator({ code }: { code: string }) {
  const [ms, setMs] = useState<number | null>(null);
  const [ok, setOk] = useState<boolean>(true);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let channel: RealtimeChannel | null = null;
    let ready = false;

    channel = supabase.channel(`latency-${code}`, {
      config: { broadcast: { ack: true, self: false } },
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        ready = true;
        ping();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        if (!cancelled) {
          setOk(false);
          setMs(null);
        }
      }
    });

    const ping = async () => {
      if (cancelled || !ready || !channel) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(ping, 4000);
        return;
      }
      const t0 = performance.now();
      try {
        const result = await channel.send({
          type: "broadcast",
          event: "ping",
          payload: { t: t0 },
        });
        const dt = Math.round(performance.now() - t0);
        if (cancelled) return;
        const success = result === "ok";
        setOk(success);
        setMs(success ? dt : null);
      } catch {
        if (cancelled) return;
        setOk(false);
        setMs(null);
      } finally {
        if (!cancelled) timer = setTimeout(ping, 10000);
      }
    };

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (channel) supabase.removeChannel(channel);
    };
  }, [code]);

  if (ms === null && ok) return null;

  const color =
    !ok ? "bg-red-500" :
    ms === null ? "bg-muted-foreground" :
    ms < 250 ? "bg-mint" :
    ms < 600 ? "bg-sun" : "bg-red-500";

  const label =
    !ok ? "Conexão instável" :
    ms === null ? "Medindo conexão" :
    `Latência ${ms} milissegundos`;

  return (
    <div
      className="flex items-center gap-1 text-[10px] text-muted-foreground"
      title={label}
      aria-label={label}
      role="status"
    >
      <span aria-hidden className={"inline-block w-2 h-2 rounded-full " + color + " " + (ok ? "animate-pulse" : "")} />
      {ms !== null && ms >= 250 && (
        <span aria-hidden className="tabular-nums">{ms}ms</span>
      )}
    </div>
  );
}


