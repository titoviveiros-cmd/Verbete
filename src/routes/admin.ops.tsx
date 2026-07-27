import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Mascot } from "@/components/Mascot";
import { scrollbarClip } from "@/lib/utils";

// Fase 8 — painel de saúde (role admin): funil + erros/reconexões/backstop.
export const Route = createFileRoute("/admin/ops")({
  head: () => ({
    meta: [
      { title: "Saúde do jogo — Verbete" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AdminOpsPage,
});

type Summary = {
  since: string;
  funnel: {
    rooms_created: number;
    games_started: number;
    rounds_played: number;
    games_finished: number;
    daily_attempts: number;
  };
  health: {
    client_errors: number;
    rpc_failures: number;
    reconnects: number;
    stalled_advances: number;
    sessions_with_errors: number;
  };
};

type OpsEvent = {
  id: number;
  at: string;
  kind: string;
  build: string | null;
  session_key: string | null;
  room_hash: string | null;
  payload: Record<string, unknown>;
};

const KIND_ICON: Record<string, string> = {
  client_error: "💥",
  boundary_crash: "🧯",
  rpc_failure: "📡",
  reconnect: "🔌",
  stalled_advance: "⏰",
};

const WINDOWS = [
  { hours: 24, label: "24h" },
  { hours: 72, label: "3 dias" },
  { hours: 168, label: "7 dias" },
];

function AdminOpsPage() {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [hours, setHours] = useState(24);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<OpsEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      nav({ to: "/login" });
      return;
    }
    (async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      setIsAdmin(!!data);
    })();
  }, [user, loading]);

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      const [sum, rec] = await Promise.all([
        supabase.rpc("admin_ops_summary", { p_hours: hours }),
        supabase.rpc("admin_ops_recent", { p_limit: 60 }),
      ]);
      if (sum.error || rec.error) {
        setError(sum.error?.message ?? rec.error?.message ?? "erro");
        return;
      }
      setSummary(sum.data as unknown as Summary);
      setEvents((rec.data as unknown as OpsEvent[]) ?? []);
      setError(null);
    })();
  }, [isAdmin, hours]);

  if (loading || isAdmin === null) {
    return (
      <div className="mobile-shell items-center justify-center">
        <Mascot mood="thinking" />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="mobile-shell items-center justify-center gap-3">
        <Mascot mood="sad" />
        <h1 className="font-display text-2xl">Acesso restrito</h1>
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          Esta área é exclusiva para editores do Verbete.
        </p>
        <Link to="/" className="btn-pop bg-gradient-fun text-white text-sm">
          Voltar ao início
        </Link>
      </div>
    );
  }

  const f = summary?.funnel;
  const h = summary?.health;

  return (
    <div className="mobile-shell pt-4 gap-3">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-sun">🩺 Saúde do jogo</h1>
        <Link to="/" className="text-sm text-muted-foreground font-display">
          ← início
        </Link>
      </div>
      <div className="flex gap-1.5">
        {WINDOWS.map((w) => (
          <button
            key={w.hours}
            onClick={() => setHours(w.hours)}
            className={
              "px-3 py-1.5 rounded-full text-xs font-display border transition " +
              (hours === w.hours
                ? "bg-pink/20 border-pink text-pink"
                : "bg-card/60 border-white/10 text-muted-foreground")
            }
          >
            {w.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="text-xs text-destructive font-display">{error}</p>
      )}
      <div
        className="flex-1 min-h-0 overflow-y-auto no-scrollbar space-y-3 pb-4"
        style={scrollbarClip()}
      >
        {f && (
          <div className="sticker space-y-1.5">
            <p className="font-display text-sm text-sun">🎯 Funil</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <span className="text-muted-foreground">Salas criadas</span>
              <span className="font-display text-right">{f.rooms_created}</span>
              <span className="text-muted-foreground">Partidas iniciadas</span>
              <span className="font-display text-right">{f.games_started}</span>
              <span className="text-muted-foreground">Rodadas jogadas</span>
              <span className="font-display text-right">{f.rounds_played}</span>
              <span className="text-muted-foreground">Partidas concluídas</span>
              <span className="font-display text-right">
                {f.games_finished}
              </span>
              <span className="text-muted-foreground">Desafios diários</span>
              <span className="font-display text-right">
                {f.daily_attempts}
              </span>
            </div>
          </div>
        )}
        {h && (
          <div className="sticker space-y-1.5">
            <p className="font-display text-sm text-sun">🚑 Saúde</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <span className="text-muted-foreground">Erros de client</span>
              <span
                className={
                  "font-display text-right " +
                  (h.client_errors > 0 ? "text-destructive" : "text-mint")
                }
              >
                {h.client_errors}
              </span>
              <span className="text-muted-foreground">Sessões afetadas</span>
              <span className="font-display text-right">
                {h.sessions_with_errors}
              </span>
              <span className="text-muted-foreground">Falhas de RPC</span>
              <span
                className={
                  "font-display text-right " +
                  (h.rpc_failures > 0 ? "text-destructive" : "text-mint")
                }
              >
                {h.rpc_failures}
              </span>
              <span className="text-muted-foreground">Quedas de canal</span>
              <span className="font-display text-right">{h.reconnects}</span>
              <span className="text-muted-foreground">Avanços do backstop</span>
              <span className="font-display text-right">
                {h.stalled_advances}
              </span>
            </div>
          </div>
        )}
        <p className="font-display text-sm text-sun pt-1">🧾 Últimos eventos</p>
        {events.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nenhum evento registrado ainda — bom sinal! 🎉
          </p>
        )}
        {events.map((e) => (
          <button
            key={e.id}
            onClick={() => setExpanded(expanded === e.id ? null : e.id)}
            className="sticker w-full text-left space-y-1"
          >
            <div className="flex items-center gap-2 text-xs">
              <span aria-hidden>{KIND_ICON[e.kind] ?? "❓"}</span>
              <span className="font-display">{e.kind}</span>
              <span className="text-muted-foreground ml-auto">
                {new Date(e.at).toLocaleString("pt-BR")}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground flex gap-2 flex-wrap">
              {e.build && <span>build {e.build}</span>}
              {e.room_hash && <span>sala #{e.room_hash}</span>}
              {e.session_key && <span>sessão #{e.session_key}</span>}
            </div>
            {expanded === e.id && (
              <pre className="text-[10px] whitespace-pre-wrap break-all bg-background/60 rounded-lg p-2 max-h-48 overflow-y-auto">
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
