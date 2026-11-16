import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/hooks/use-auth";
import { CONTACT_EMAIL, contactMailto } from "@/lib/legal";
import {
  APPEAL_REVIEW_DAYS,
  APPEAL_WINDOW_DAYS,
  REPORT_REVIEW_HOURS,
  type OffenderNotice,
  type ReporterView,
} from "@/lib/moderation-policy";
import {
  appealModeration,
  getMyModerationNotices,
  getMyReports,
} from "@/lib/moderation.functions";

// ECA Digital (Lei 15.211/2025) arts. 28–30 e Lei 14.852/2024 art. 16 I–III
// e VIII (11/11/2026): canal de denúncia público (art. 29 §3º), retorno ao
// denunciante, aviso ao autor com motivo e "análise humana", recurso com
// prazos — tudo em português simples. Os PRAZOS vêm de moderation-policy.ts
// (escolha de produto; validar com advogado(a) antes de publicar).
export const Route = createFileRoute("/denuncias")({
  head: () => ({
    meta: [
      { title: "Denúncias — Verbete" },
      // Sem READING_VIEWPORT: a lista de páginas com zoom livre é fechada
      // (final-adjustments.test.ts; lib/viewport.ts). Incluir /denuncias lá
      // é uma decisão de UX à parte.
      {
        name: "description",
        content:
          "Como denunciar no Verbete, prazos de análise, avisos de moderação e como contestar uma decisão.",
      },
      { name: "robots", content: "index,follow" },
    ],
  }),
  component: DenunciasPage,
});

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });

function DenunciasPage() {
  const { user, loading } = useAuth();
  return (
    <div className="mobile-shell overflow-y-auto pb-8">
      <header className="mb-6">
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Voltar
        </Link>
        <h1 className="font-display text-3xl mt-2">Denúncias</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Como denunciar, quanto tempo leva e como contestar uma decisão.
        </p>
      </header>

      <section className="sticker p-4 mb-6">
        <h2 className="font-display text-lg mb-2">🚩 Como funciona</h2>
        <ol className="text-sm space-y-2 list-decimal pl-5">
          <li>
            Na partida, toque na 🚩 de uma definição ou em “Denunciar jogador”.
          </li>
          <li>
            Uma pessoa da equipe analisa em até {REPORT_REVIEW_HOURS} horas. O
            resultado aparece nesta página, em “Minhas denúncias”.
          </li>
          <li>
            Se houver violação das regras, o conteúdo é removido ou a conta é
            suspensa. Quem escreveu recebe um aviso com o motivo e pode
            contestar em até {APPEAL_WINDOW_DAYS} dias. Respondemos o recurso em
            até {APPEAL_REVIEW_DAYS} dias.
          </li>
          <li>
            A denúncia não é anônima para a equipe, mas{" "}
            <strong>quem foi denunciado nunca sabe quem denunciou</strong>.
          </li>
          <li>
            Denunciar de propósito para prejudicar alguém é proibido e pode
            levar à suspensão.
          </li>
        </ol>
      </section>

      <section className="sticker p-4 mb-6">
        <h2 className="font-display text-lg mb-2">
          👪 Não está na sala? Pais e responsáveis
        </h2>
        <p className="text-sm mb-3">
          Escreva para o e-mail abaixo com o código da sala, o apelido e o que
          aconteceu. Vale para quem sofreu algo, pais, responsáveis e
          autoridades.
        </p>
        <a
          href={contactMailto("Denúncia Verbete")}
          className="btn-pop btn-gold inline-block max-w-full break-all"
        >
          {CONTACT_EMAIL}
        </a>
        <p className="text-xs text-muted-foreground mt-3">
          Perigo imediato: ligue 190. Violência contra criança ou adolescente:
          Disque 100.
        </p>
      </section>

      {loading ? null : user ? (
        <MyModeration />
      ) : (
        <p className="text-sm text-muted-foreground text-center">
          Jogue uma partida neste aparelho para acompanhar suas denúncias aqui.
        </p>
      )}

      <footer className="mt-8 text-center text-xs text-muted-foreground">
        <Link to="/terms" className="underline mr-3">
          Termos
        </Link>
        <Link to="/privacy" className="underline mr-3">
          Privacidade
        </Link>
        <Link to="/support" className="underline">
          Suporte
        </Link>
      </footer>
    </div>
  );
}

function MyModeration() {
  const runReports = useServerFn(getMyReports);
  const runNotices = useServerFn(getMyModerationNotices);
  const [reports, setReports] = useState<ReporterView[] | null>(null);
  const [notices, setNotices] = useState<OffenderNotice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [r, n] = await Promise.all([runReports(), runNotices()]);
      setReports(r.reports);
      setNotices(n.notices);
      setError(null);
    } catch {
      setError("Não foi possível carregar agora. Tente de novo mais tarde.");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {error && (
        <p role="alert" className="text-xs text-destructive mb-4">
          {error}
        </p>
      )}

      {notices && notices.length > 0 && (
        <section className="mb-6">
          <h2 className="font-display text-xl mb-3">⚠️ Avisos sobre você</h2>
          <ul className="space-y-2">
            {notices.map((n) => (
              <NoticeItem key={n.reportId} notice={n} onDone={load} />
            ))}
          </ul>
        </section>
      )}

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">Minhas denúncias</h2>
        {reports === null ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Você ainda não fez nenhuma denúncia.
          </p>
        ) : (
          <ul className="space-y-2">
            {reports.map((r) => (
              <li key={r.id} className="sticker p-3 text-sm">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {r.kind === "definicao" ? "definição" : "jogador"} · enviada{" "}
                  {fmt(r.createdAt)}
                </p>
                <p className="mt-1">{r.resultLabel}</p>
                {r.reviewKind && (
                  <p className="text-xs text-muted-foreground">
                    Análise {r.reviewKind}.
                  </p>
                )}
                {r.overdue && (
                  <p className="text-xs text-muted-foreground">
                    Passou do prazo — pedimos desculpas; ainda vamos analisar.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function NoticeItem({
  notice: n,
  onDone,
}: {
  notice: OffenderNotice;
  onDone: () => Promise<void>;
}) {
  const runAppeal = useServerFn(appealModeration);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    setSending(true);
    setErr(null);
    try {
      await runAppeal({ data: { reportId: n.reportId, text } });
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Não foi possível enviar.");
    } finally {
      setSending(false);
    }
  };

  return (
    <li className="sticker p-3 text-sm flex flex-col gap-2">
      <p className="font-display">{n.actionLabel}</p>
      <blockquote className="rounded-xl bg-input/60 p-2 italic text-xs break-words">
        “{n.content}”
      </blockquote>
      <p>
        <strong>Motivo:</strong> {n.reasonLabel}.
      </p>
      <p className="text-xs text-muted-foreground">
        Decisão de {fmt(n.decidedAt)} · análise {n.reviewKind}.
      </p>
      {n.appeal ? (
        <div className="text-xs">
          <p>{n.appeal.statusLabel}.</p>
          {n.appeal.status === "pending" && (
            <p className="text-muted-foreground">
              Resposta até {fmt(n.appeal.dueAt)}.
            </p>
          )}
          {n.appeal.note && <p className="mt-1">Resposta: {n.appeal.note}</p>}
        </div>
      ) : n.canAppeal ? (
        <div className="flex flex-col gap-2">
          <label className="text-xs" htmlFor={`appeal-${n.reportId}`}>
            Não concorda? Conte o que aconteceu (até {fmt(n.appealDeadline)}):
          </label>
          <textarea
            id={`appeal-${n.reportId}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            rows={3}
            className="bg-input rounded-xl px-3 py-2 border border-white/10 text-sm"
          />
          {err && (
            <p role="alert" className="text-xs text-destructive">
              {err}
            </p>
          )}
          <button
            disabled={sending || text.trim().length < 5}
            onClick={send}
            className="btn-pop btn-gold text-sm self-start"
          >
            {sending ? "Enviando…" : "Contestar decisão"}
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          O prazo para contestar terminou em {fmt(n.appealDeadline)}.
        </p>
      )}
    </li>
  );
}
