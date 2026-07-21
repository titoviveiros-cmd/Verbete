import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Mascot } from "@/components/Mascot";
import { scrollbarClip } from "@/lib/utils";

// Fase 9 — revisão editorial do banco de palavras (role admin).
// Lista por status, permite editar o significado e publicar/rejeitar.
export const Route = createFileRoute("/admin/words")({
  head: () => ({
    meta: [
      { title: "Editorial de palavras — Verbete" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AdminWordsPage,
});

type EditorialWord = {
  id: string;
  word: string;
  meaning: string;
  category: string | null;
  rarity: number;
  nivel: string;
  classe: string | null;
  pronuncia: string | null;
  origem: string | null;
  curiosidade: string | null;
  exemplo: string | null;
  status: string;
  review_notes: string | null;
};

const STATUSES = [
  { key: "ai_generated", label: "🤖 geradas" },
  { key: "draft", label: "📝 rascunho" },
  { key: "published", label: "✅ publicadas" },
  { key: "rejected", label: "🗑 rejeitadas" },
];

function AdminWordsPage() {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [status, setStatus] = useState("ai_generated");
  const [words, setWords] = useState<EditorialWord[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

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

  const refresh = async (st = status) => {
    const { data, error: err } = await (
      supabase.rpc as never as (
        fn: string,
        args: object,
      ) => Promise<{ data: unknown; error: { message: string } | null }>
    )("admin_list_words", { p_status: st, p_limit: 60 });
    if (err) {
      setError(err.message);
      return;
    }
    const payload = data as {
      ok: boolean;
      reason?: string;
      total?: number;
      words?: EditorialWord[];
    };
    if (!payload?.ok) {
      setError(payload?.reason ?? "erro");
      return;
    }
    setWords(payload.words ?? []);
    setTotal(payload.total ?? 0);
    setError(null);
  };

  useEffect(() => {
    if (isAdmin) void refresh(status);
  }, [isAdmin, status]);

  const review = async (id: string, action: "publish" | "reject") => {
    setBusy(id);
    try {
      const { data } = await (
        supabase.rpc as never as (
          fn: string,
          args: object,
        ) => Promise<{ data: unknown }>
      )("admin_review_word", {
        p_word_id: id,
        p_action: action,
        p_meaning: edits[id] ?? null,
        p_notes: `revisado no /admin/words em ${new Date().toISOString().slice(0, 10)}`,
      });
      if ((data as { ok?: boolean })?.ok) {
        setWords((w) => w.filter((x) => x.id !== id));
        setTotal((t) => Math.max(0, t - 1));
      }
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
          Esta área é exclusiva para editores do Verbete.
        </p>
        <Link to="/" className="btn-pop bg-gradient-fun text-white text-sm">
          Voltar ao início
        </Link>
      </div>
    );
  }

  return (
    <div className="mobile-shell pt-4 gap-3">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-sun">📚 Editorial</h1>
        <Link to="/" className="text-sm text-muted-foreground font-display">
          ← início
        </Link>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => setStatus(s.key)}
            className={
              "px-3 py-1.5 rounded-full text-xs font-display border transition " +
              (status === s.key
                ? "bg-pink/20 border-pink text-pink"
                : "bg-card/60 border-white/10 text-muted-foreground")
            }
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground font-display">
        {total} palavra{total === 1 ? "" : "s"} neste status
      </p>
      {error && (
        <p className="text-xs text-destructive font-display">{error}</p>
      )}
      <div
        className="flex-1 min-h-0 overflow-y-auto no-scrollbar space-y-2 pb-4"
        style={scrollbarClip()}
      >
        {words.map((w) => (
          <div key={w.id} className="sticker space-y-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-display text-xl capitalize">{w.word}</span>
              <span className="text-[11px] text-muted-foreground font-display">
                {w.classe} · {w.category} · {w.nivel} · r{w.rarity}
              </span>
            </div>
            <textarea
              defaultValue={w.meaning}
              onChange={(e) =>
                setEdits((m) => ({ ...m, [w.id]: e.target.value }))
              }
              rows={2}
              className="w-full bg-input rounded-xl px-3 py-2 text-sm border border-white/10 outline-none"
            />
            {w.curiosidade && (
              <p className="text-[11px] text-muted-foreground leading-snug">
                💡 {w.curiosidade}
              </p>
            )}
            <div className="flex gap-2">
              {status !== "published" && (
                <button
                  disabled={busy === w.id}
                  onClick={() => review(w.id, "publish")}
                  className="flex-1 btn-pop bg-gradient-mint text-accent-foreground text-sm !py-2 disabled:opacity-50"
                >
                  ✅ Publicar
                </button>
              )}
              {status !== "rejected" && (
                <button
                  disabled={busy === w.id}
                  onClick={() => review(w.id, "reject")}
                  className="flex-1 btn-pop bg-card border border-destructive/50 text-destructive text-sm !py-2 disabled:opacity-50"
                >
                  🗑 Rejeitar
                </button>
              )}
            </div>
          </div>
        ))}
        {words.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-8">
            Nada por aqui. 🎉
          </p>
        )}
      </div>
    </div>
  );
}
