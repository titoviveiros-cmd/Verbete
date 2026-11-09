import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Mascot } from "@/components/Mascot";
import { scrollbarClip } from "@/lib/utils";
import {
  addDailyChoiceDrafts,
  editDailyChoice,
  getDailyChoicePool,
  listDailyChoices,
  reviewDailyChoices,
} from "@/lib/daily-choice.functions";
import { buildDrafts } from "@/lib/daily-choice-admin";
import { DailyChoiceManifest } from "@/components/DailyChoiceManifest";

// Diário D1 — revisão dos conjuntos do modo escolha (papel admin).
// Rascunhos vêm do acervo (definições de outras palavras publicadas, sem IA).
// Nada entra no jogo sem aprovação aqui: individual ou em lote SELECIONADO.
export const Route = createFileRoute("/admin/daily-choices")({
  head: () => ({
    meta: [
      { title: "Diário — revisão das alternativas — Verbete" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AdminDailyChoicesPage,
});

type Status = "rascunho" | "aprovado" | "reprovado";
type Item = {
  word_id: string;
  word: string;
  truth: string;
  category: string | null;
  classe: string | null;
  distractors: string[] | null;
  status: string | null;
  truth_changed: boolean;
  published: boolean;
  validacao: { ok?: boolean; issues?: Array<{ index: number; msg: string }> };
};

const TABS: Array<{ key: Status; label: string }> = [
  { key: "rascunho", label: "📝 rascunhos" },
  { key: "aprovado", label: "✅ aprovados" },
  { key: "reprovado", label: "🗑 reprovados" },
];
/** D-e: estoque mínimo para ligar o modo escolha (7 dias × 24 horas). */
const META = 168;

function AdminDailyChoicesPage() {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const list = useServerFn(listDailyChoices);
  const getPool = useServerFn(getDailyChoicePool);
  const addDrafts = useServerFn(addDailyChoiceDrafts);
  const review = useServerFn(reviewDailyChoices);
  const edit = useServerFn(editDailyChoice);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status>("rascunho");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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
  }, [user, loading, nav]);

  const refresh = async (st = status, off = offset) => {
    try {
      const r = await list({ data: { status: st, offset: off } });
      setItems((r.items ?? []) as Item[]);
      setTotal(r.total ?? 0);
      setCounts(r.counts ?? {});
      setSel(new Set());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "erro ao carregar");
    }
  };

  useEffect(() => {
    if (isAdmin) void refresh(status, offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, status, offset]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await fn());
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "erro");
    } finally {
      setBusy(false);
    }
  };

  const doReview = (ids: string[], st: Status) =>
    run(async () => {
      const r = await review({ data: { wordIds: ids, status: st } });
      const probs = r.problems
        .map((p) => `• ${p.word || "?"}: ${p.reasons.join("; ")}`)
        .join("\n");
      return `${r.updated} atualizado(s), ${r.skipped} pulado(s).${probs ? "\n" + probs : ""}`;
    });

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
        <Link to="/" className="btn-pop btn-gold text-sm">
          Voltar ao início
        </Link>
      </div>
    );
  }

  const jogaveis = counts.aprovado_jogavel ?? 0;
  const allSel = items.length > 0 && items.every((i) => sel.has(i.word_id));

  return (
    <div className="mobile-shell stage-wide pt-4 gap-3">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-sun">
          🎯 Diário — alternativas
        </h1>
        <Link to="/" className="text-sm text-muted-foreground font-display">
          ← início
        </Link>
      </div>
      <div className="panel !rounded-2xl px-3 py-2 text-xs font-display flex flex-wrap gap-x-4 gap-y-1">
        <span className={jogaveis >= META ? "text-mint" : "text-sun"}>
          aprovados jogáveis: {jogaveis}/{META}
        </span>
        <span>rascunhos: {counts.rascunho ?? 0}</span>
        <span>reprovados: {counts.reprovado ?? 0}</span>
        <span>elegíveis sem conjunto: {counts.sem_conjunto ?? 0}</span>
      </div>
      <DailyChoiceManifest onChanged={() => void refresh()} />
      <button
        disabled={busy}
        onClick={() =>
          run(async () => {
            // gera NO NAVEGADOR (sem CPU no servidor); o servidor re-valida e grava rascunhos
            const pool = await getPool({ data: { limit: 200 } });
            const d = buildDrafts(pool);
            let inserted = 0;
            let invalid = 0;
            for (let i = 0; i < d.rows.length; i += 100) {
              const r = await addDrafts({
                data: { rows: d.rows.slice(i, i + 100) },
              });
              inserted += r.inserted;
              invalid += r.invalid;
            }
            return `Rascunhos: ${inserted} novos de ${d.targets} palavras (${d.semCandidatos} sem 3 alternativas boas no acervo; ${invalid} com aviso do validador). Nada foi aprovado.`;
          })
        }
        className="btn-pop btn-plain text-sm !py-2"
      >
        📝 Gerar rascunhos do acervo (até 200)
      </button>
      <div className="flex gap-1.5 flex-wrap">
        {TABS.map((s) => (
          <button
            key={s.key}
            onClick={() => {
              setStatus(s.key);
              setOffset(0);
            }}
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
      <div className="flex items-center gap-2 flex-wrap text-xs font-display">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={allSel}
            onChange={(e) =>
              setSel(
                e.target.checked
                  ? new Set(items.map((i) => i.word_id))
                  : new Set(),
              )
            }
          />
          selecionar os {items.length} desta página
        </label>
        <span className="text-muted-foreground">
          {total} neste status · {sel.size} selecionado(s)
        </span>
        {status !== "aprovado" && (
          <button
            disabled={busy || sel.size === 0}
            onClick={() => doReview([...sel], "aprovado")}
            className="btn-pop bg-gradient-mint text-accent-foreground !py-1.5 !px-3 text-xs"
          >
            ✅ Aprovar selecionados ({sel.size})
          </button>
        )}
        {status !== "reprovado" && (
          <button
            disabled={busy || sel.size === 0}
            onClick={() => doReview([...sel], "reprovado")}
            className="btn-pop btn-plain border border-destructive/50 text-destructive !py-1.5 !px-3 text-xs"
          >
            🗑 Reprovar selecionados ({sel.size})
          </button>
        )}
      </div>
      {msg && (
        <p
          role="status"
          className="text-xs font-display whitespace-pre-line text-muted-foreground"
        >
          {msg}
        </p>
      )}
      <div
        className="flex-1 min-h-0 overflow-y-auto no-scrollbar space-y-2 pb-4"
        style={scrollbarClip()}
      >
        {items.map((it) => {
          const ed = editing[it.word_id];
          const issues = it.validacao?.issues ?? [];
          return (
            <div key={it.word_id} className="sticker space-y-2">
              <div className="flex items-baseline gap-2 flex-wrap">
                <input
                  type="checkbox"
                  aria-label={`selecionar ${it.word}`}
                  checked={sel.has(it.word_id)}
                  onChange={(e) =>
                    setSel((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(it.word_id);
                      else n.delete(it.word_id);
                      return n;
                    })
                  }
                />
                <span className="font-display text-xl capitalize">
                  {it.word}
                </span>
                <span className="text-[11px] text-muted-foreground font-display">
                  {it.classe} · {it.category}
                </span>
              </div>
              <p className="text-sm text-mint leading-snug">✓ {it.truth}</p>
              {(ed ?? it.distractors ?? []).map((d, i) =>
                ed ? (
                  <input
                    key={i}
                    value={d}
                    aria-label={`distrator ${i + 1}`}
                    maxLength={200}
                    onChange={(e) =>
                      setEditing((m) => ({
                        ...m,
                        [it.word_id]: (m[it.word_id] ?? []).map((x, j) =>
                          j === i ? e.target.value : x,
                        ),
                      }))
                    }
                    className="w-full bg-input rounded-xl px-3 py-1.5 text-sm border border-white/10 outline-none"
                  />
                ) : (
                  <p key={i} className="text-sm leading-snug">
                    ✗ {d}
                  </p>
                ),
              )}
              {it.truth_changed && (
                <p className="text-[11px] text-sun">
                  ⚠ A definição da palavra mudou depois do rascunho: edite e
                  salve para revalidar.
                </p>
              )}
              {!it.published && (
                <p className="text-[11px] text-sun">
                  ⚠ Palavra não publicada: não entra no jogo.
                </p>
              )}
              {issues.length > 0 && (
                <ul className="text-[11px] text-destructive list-disc pl-4">
                  {issues.map((x, k) => (
                    <li key={k}>
                      {x.index >= 0 ? `distrator ${x.index + 1}: ` : ""}
                      {x.msg}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                {ed ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const r = await edit({
                            data: { wordId: it.word_id, distractors: ed },
                          });
                          setEditing((m) => {
                            const n = { ...m };
                            delete n[it.word_id];
                            return n;
                          });
                          return r.validacao.ok
                            ? "Salvo como rascunho (validador OK)."
                            : "Salvo como rascunho, mas o validador apontou problemas.";
                        })
                      }
                      className="flex-1 btn-pop btn-gold text-sm !py-2"
                    >
                      💾 Salvar
                    </button>
                    <button
                      onClick={() =>
                        setEditing((m) => {
                          const n = { ...m };
                          delete n[it.word_id];
                          return n;
                        })
                      }
                      className="flex-1 btn-pop btn-plain text-sm !py-2"
                    >
                      Cancelar
                    </button>
                  </>
                ) : (
                  <>
                    {status !== "aprovado" && (
                      <button
                        disabled={busy}
                        onClick={() => doReview([it.word_id], "aprovado")}
                        className="flex-1 btn-pop bg-gradient-mint text-accent-foreground text-sm !py-2"
                      >
                        ✅ Aprovar
                      </button>
                    )}
                    {status !== "reprovado" && (
                      <button
                        disabled={busy}
                        onClick={() => doReview([it.word_id], "reprovado")}
                        className="flex-1 btn-pop btn-plain border border-destructive/50 text-destructive text-sm !py-2"
                      >
                        🗑 Reprovar
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() =>
                        setEditing((m) => ({
                          ...m,
                          [it.word_id]: [...(it.distractors ?? ["", "", ""])],
                        }))
                      }
                      className="btn-pop btn-plain text-sm !py-2 !px-3"
                    >
                      ✏️
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {items.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-8">
            Nada por aqui.
          </p>
        )}
        {total > offset + items.length && (
          <button
            onClick={() => setOffset((o) => o + 50)}
            className="btn-pop btn-plain text-sm w-full !py-2"
          >
            Próximos 50 →
          </button>
        )}
        {offset > 0 && (
          <button
            onClick={() => setOffset((o) => Math.max(0, o - 50))}
            className="btn-pop btn-plain text-sm w-full !py-2"
          >
            ← Anteriores
          </button>
        )}
      </div>
    </div>
  );
}
