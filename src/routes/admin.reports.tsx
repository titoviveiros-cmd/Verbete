import {
  createFileRoute,
  Link,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  decideAppeal,
  listPendingAppeals,
  listPendingReports,
  resolveReport,
} from "@/lib/moderation.functions";
import {
  DECISION_REASONS,
  DECISION_REASON_KEYS,
  REPORT_REVIEW_HOURS,
  reviewDueAt,
  type DecisionReason,
} from "@/lib/moderation-policy";
import type { AppealForReview } from "@/lib/report-feedback";
import { isPlayerReport, playerReasonLabel } from "@/lib/report-player-reasons";
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
  // ECA Digital art. 30: remoção/ban levam MOTIVO, que o autor vê no aviso.
  const [motive, setMotive] = useState<Record<string, DecisionReason>>({});
  const [appeals, setAppeals] = useState<AppealForReview[]>([]);
  const [appealNote, setAppealNote] = useState<Record<string, string>>({});

  const runList = useServerFn(listPendingReports);
  const runResolve = useServerFn(resolveReport);
  const runAppeals = useServerFn(listPendingAppeals);
  const runDecide = useServerFn(decideAppeal);

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
      const ok = !!data;
      setIsAdmin(ok);
      if (ok) await refresh();
    })();
  }, [user, loading]);

  const refresh = async () => {
    try {
      const [res, ap] = await Promise.all([runList(), runAppeals()]);
      setReports(res.reports as Report[]);
      setAppeals(ap.appeals);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao carregar.");
    }
  };

  const handle = async (
    reportId: string,
    action: "dismiss" | "remove_content" | "ban",
    banDays = 30,
  ) => {
    setBusy(reportId);
    try {
      await runResolve({
        data: {
          reportId,
          action,
          banScope: "both",
          banDays,
          decisionReason:
            action === "dismiss" ? undefined : (motive[reportId] ?? "ofensa"),
        },
      });
      setReports((r) => r.filter((x) => x.id !== reportId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro.");
    } finally {
      setBusy(null);
    }
  };

  const decide = async (appealId: string, outcome: "upheld" | "reversed") => {
    const note = (appealNote[appealId] ?? "").trim();
    if (!note) {
      setError("Escreva a resposta ao recurso (o autor vai ler).");
      return;
    }
    setBusy(appealId);
    try {
      await runDecide({ data: { appealId, outcome, note } });
      setAppeals((a) => a.filter((x) => x.id !== appealId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro.");
    } finally {
      setBusy(null);
    }
  };

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
          Esta área é exclusiva para moderadores do Verbete.
        </p>
        <Link to="/" className="btn-pop btn-gold text-sm">
          Voltar ao início
        </Link>
      </div>
    );
  }

  return (
    <div className="mobile-shell pt-4 gap-3 overflow-y-auto pb-8">
      <div className="flex items-center justify-between">
        <Link
          to={fromProfile ? "/profile" : "/"}
          className="btn-pop btn-plain text-xs px-3 py-2 font-display flex items-center gap-1"
        >
          <span>←</span> {fromProfile ? "Voltar" : "Início"}
        </Link>
        <button
          onClick={refresh}
          className="btn-pop btn-plain text-xs px-3 py-2 font-display flex items-center gap-1"
        >
          Atualizar <span>🔄</span>
        </button>
      </div>

      <header className="text-center mt-2">
        <h1 className="font-display text-3xl mt-2 flex items-center justify-center gap-2">
          <span aria-hidden>🛡️</span>
          <span>Moderação</span>
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          {reports.length} denúncia{reports.length !== 1 ? "s" : ""} pendente
          {reports.length !== 1 ? "s" : ""}
        </p>
      </header>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {reports.length === 0 ? (
        <div className="sticker bg-mint/10 border border-mint/30 p-6 text-center">
          <div className="text-4xl mb-2">✨</div>
          <p className="text-sm font-display">Tudo limpo!</p>
          <p className="text-xs text-muted-foreground mt-1">
            Nenhuma denúncia pendente.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="sticker p-3 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {isPlayerReport(r)
                      ? `jogador · ${playerReasonLabel(r.reason)}`
                      : `definição · ${r.reason}`}{" "}
                    · sala {r.room_code ?? "?"} · rodada {r.round ?? "?"}
                  </p>
                  <p className="font-display text-sm mt-0.5 truncate">
                    👤 {r.offender_nickname ?? r.offender_player_id.slice(0, 8)}
                  </p>
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0 text-right">
                  {new Date(r.created_at).toLocaleString("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                  <br />
                  prazo {REPORT_REVIEW_HOURS} h:{" "}
                  {new Date(reviewDueAt(r.created_at)).toLocaleString("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </span>
              </div>

              <blockquote className="rounded-xl bg-input/60 p-2 text-sm italic border-l-2 border-pink/50">
                "{r.definition_text}"
              </blockquote>

              <label className="text-[11px] text-muted-foreground flex items-center gap-2">
                Motivo (para remover/banir):
                <select
                  value={motive[r.id] ?? "ofensa"}
                  onChange={(e) =>
                    setMotive((m) => ({
                      ...m,
                      [r.id]: e.target.value as DecisionReason,
                    }))
                  }
                  className="bg-input rounded-lg px-2 py-1 text-xs border border-white/10"
                >
                  {DECISION_REASON_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {DECISION_REASONS[k]}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex gap-1.5 flex-wrap">
                <button
                  disabled={busy === r.id}
                  onClick={() => handle(r.id, "dismiss")}
                  className="btn-pop btn-plain border border-white/10 text-xs py-1.5 px-2.5"
                >
                  Descartar
                </button>
                <button
                  disabled={busy === r.id}
                  onClick={() => handle(r.id, "remove_content")}
                  className="btn-pop bg-mint/20 border border-mint/40 text-xs py-1.5 px-2.5"
                >
                  Remover conteúdo
                </button>
                <button
                  disabled={busy === r.id}
                  onClick={() => handle(r.id, "ban", 7)}
                  className="btn-pop bg-sun/20 border border-sun/40 text-xs py-1.5 px-2.5"
                >
                  Banir 7d
                </button>
                <button
                  disabled={busy === r.id}
                  onClick={() => handle(r.id, "ban", 30)}
                  className="btn-pop bg-pink/20 border border-pink/40 text-xs py-1.5 px-2.5"
                >
                  Banir 30d
                </button>
                <button
                  disabled={busy === r.id}
                  onClick={() => handle(r.id, "ban", 0)}
                  className="btn-pop bg-destructive text-destructive-foreground text-xs py-1.5 px-2.5"
                >
                  Ban perma
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-4">
        <h2 className="font-display text-xl">
          Recursos pendentes ({appeals.length})
        </h2>
        {appeals.length === 0 ? (
          <p className="text-xs text-muted-foreground mt-1">
            Nenhum recurso aguardando resposta.
          </p>
        ) : (
          <ul className="space-y-2 mt-2">
            {appeals.map((a) => (
              <li key={a.id} className="sticker p-3 flex flex-col gap-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {a.action ?? "?"} ·{" "}
                  {a.decisionReason
                    ? (DECISION_REASONS[a.decisionReason as DecisionReason] ??
                      a.decisionReason)
                    : "sem motivo"}{" "}
                  · responder até{" "}
                  {new Date(a.dueAt).toLocaleString("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </p>
                <p className="font-display text-sm">
                  👤 {a.offenderNickname ?? "—"}
                </p>
                <blockquote className="rounded-xl bg-input/60 p-2 text-sm italic border-l-2 border-pink/50">
                  "{a.content}"
                </blockquote>
                <p className="text-sm">
                  <strong>Recurso:</strong> {a.text}
                </p>
                <textarea
                  value={appealNote[a.id] ?? ""}
                  onChange={(e) =>
                    setAppealNote((n) => ({ ...n, [a.id]: e.target.value }))
                  }
                  maxLength={500}
                  rows={2}
                  placeholder="Resposta ao autor (ele vai ler)"
                  className="bg-input rounded-xl px-3 py-2 border border-white/10 text-sm"
                />
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    disabled={busy === a.id}
                    onClick={() => decide(a.id, "upheld")}
                    className="btn-pop btn-plain border border-white/10 text-xs py-1.5 px-2.5"
                  >
                    Manter medida
                  </button>
                  <button
                    disabled={busy === a.id}
                    onClick={() => decide(a.id, "reversed")}
                    className="btn-pop bg-mint/20 border border-mint/40 text-xs py-1.5 px-2.5"
                  >
                    Reverter
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
