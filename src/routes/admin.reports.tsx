import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { listPendingReports, resolveReport } from "@/lib/moderation.functions";
import { Mascot } from "@/components/Mascot";

export const Route = createFileRoute("/admin/reports")({
  head: () => ({
    meta: [
      { title: "Moderação — Verbete" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AdminReportsPage,
});

type Report = {
  id: string;
  definition_id: string | null;
  definition_text: string;
  room_code: string | null;
  round: number | null;
  offender_player_id: string;
  offender_user_id: string | null;
  offender_nickname: string | null;
  reporter_user_id: string;
  reason: string;
  created_at: string;
};

function AdminReportsPage() {
  const nav = useNavigate();
  const search = useSearch({ strict: false }) as { from?: string };
  const fromProfile = search.from === "profile";
  const { user, loading } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runList = useServerFn(listPendingReports);
  const runResolve = useServerFn(resolveReport);

  useEffect(() => {
    if (loading) return;
    if (!user) { nav({ to: "/login" }); return; }
    (async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      const ok = !!data;
      setIsAdmin(ok);
      if (ok) await refresh();
    })();
  }, [user, loading]);

  const refresh = async () => {
    try {
      const res = await runList();
      setReports(res.reports as Report[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao carregar.");
    }
  };

  const handle = async (
    reportId: string,
    action: "dismiss" | "ban",
    banDays = 30,
  ) => {
    setBusy(reportId);
    try {
      await runResolve({
        data: { reportId, action, banScope: "both", banDays },
      });
      setReports((r) => r.filter((x) => x.id !== reportId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro.");
    } finally {
      setBusy(null);
    }
  };

  if (loading || isAdmin === null) {
    return <div className="mobile-shell items-center justify-center"><Mascot mood="thinking" /></div>;
  }

  if (!isAdmin) {
    return (
      <div className="mobile-shell items-center justify-center gap-3">
        <Mascot mood="sad" />
        <h1 className="font-display text-2xl">Acesso restrito</h1>
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          Esta área é exclusiva para moderadores do Verbete.
        </p>
        <Link to="/" className="btn-pop bg-gradient-fun text-white text-sm">Voltar ao início</Link>
      </div>
    );
  }

  return (
    <div className="mobile-shell pt-4 gap-3 overflow-y-auto pb-8">
      <div className="flex items-center justify-between">
        <Link to={fromProfile ? "/profile" : "/"} className="btn-pop bg-card text-xs px-3 py-2 font-display flex items-center gap-1">
          <span>←</span> {fromProfile ? "Voltar" : "Início"}
        </Link>
        <button onClick={refresh} className="btn-pop bg-card text-xs px-3 py-2 font-display flex items-center gap-1">
          Atualizar <span>🔄</span>
        </button>
      </div>

      <header className="text-center mt-2">
        <h1 className="font-display text-3xl mt-2 flex items-center justify-center gap-2">
          <span aria-hidden>🛡️</span>
          <span>Moderação</span>
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          {reports.length} denúncia{reports.length !== 1 ? "s" : ""} pendente{reports.length !== 1 ? "s" : ""}
        </p>
      </header>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {reports.length === 0 ? (
        <div className="sticker bg-mint/10 border border-mint/30 p-6 text-center">
          <div className="text-4xl mb-2">✨</div>
          <p className="text-sm font-display">Tudo limpo!</p>
          <p className="text-xs text-muted-foreground mt-1">Nenhuma denúncia pendente.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="sticker p-3 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {r.reason} · sala {r.room_code ?? "?"} · rodada {r.round ?? "?"}
                  </p>
                  <p className="font-display text-sm mt-0.5 truncate">
                    👤 {r.offender_nickname ?? r.offender_player_id.slice(0, 8)}
                  </p>
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {new Date(r.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                </span>
              </div>

              <blockquote className="rounded-xl bg-input/60 p-2 text-sm italic border-l-2 border-pink/50">
                "{r.definition_text}"
              </blockquote>

              <div className="flex gap-1.5 flex-wrap">
                <button
                  disabled={busy === r.id}
                  onClick={() => handle(r.id, "dismiss")}
                  className="btn-pop bg-card border border-white/10 text-xs py-1.5 px-2.5 disabled:opacity-50"
                >
                  Descartar
                </button>
                <button
                  disabled={busy === r.id}
                  onClick={() => handle(r.id, "ban", 7)}
                  className="btn-pop bg-sun/20 border border-sun/40 text-xs py-1.5 px-2.5 disabled:opacity-50"
                >
                  Banir 7d
                </button>
                <button
                  disabled={busy === r.id}
                  onClick={() => handle(r.id, "ban", 30)}
                  className="btn-pop bg-pink/20 border border-pink/40 text-xs py-1.5 px-2.5 disabled:opacity-50"
                >
                  Banir 30d
                </button>
                <button
                  disabled={busy === r.id}
                  onClick={() => handle(r.id, "ban", 0)}
                  className="btn-pop bg-destructive text-destructive-foreground text-xs py-1.5 px-2.5 disabled:opacity-50"
                >
                  Ban perma
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


