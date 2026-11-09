// Diário D1 — lote REVISADO fora do painel (manifesto com hash por conjunto).
// O admin cola o manifesto (não é salvo nem enviado a outro lugar); o painel
// mostra só aquelas palavras e o estado de cada uma. Importar e aprovar passam
// pelo servidor, que recalcula o hash e recusa o que divergir do revisado.
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  addDailyChoiceDrafts,
  editDailyChoice,
  getDailyChoicesByIds,
  reviewDailyChoices,
} from "@/lib/daily-choice.functions";
import {
  compareManifest,
  parseManifest,
  type Manifest,
  type ManifestRow,
  type ManifestStatus,
} from "@/lib/daily-choice-manifest";
import type { AdminItem } from "@/lib/daily-choice-admin";

const LABEL: Record<ManifestStatus, string> = {
  importar: "pronto para importar",
  identico: "idêntico ao revisado",
  divergente: "DIVERGENTE do revisado",
  definicao_mudou: "definição mudou — revisar de novo",
  nao_publicada: "palavra não publicada",
  inexistente: "palavra inexistente",
};
const TONE: Record<ManifestStatus, string> = {
  importar: "text-sun",
  identico: "text-mint",
  divergente: "text-destructive",
  definicao_mudou: "text-destructive",
  nao_publicada: "text-destructive",
  inexistente: "text-destructive",
};

export function DailyChoiceManifest({ onChanged }: { onChanged: () => void }) {
  const getByIds = useServerFn(getDailyChoicesByIds);
  const addDrafts = useServerFn(addDailyChoiceDrafts);
  const review = useServerFn(reviewDailyChoices);
  const edit = useServerFn(editDailyChoice);
  const [text, setText] = useState("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [rows, setRows] = useState<ManifestRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const conferir = async (m: Manifest | null = manifest) => {
    if (!m) return;
    const items = (await getByIds({
      data: { wordIds: m.itens.map((x) => x.word_id) },
    })) as AdminItem[];
    setRows(await compareManifest(m, items));
  };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await fn());
      await conferir();
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "erro");
    } finally {
      setBusy(false);
    }
  };
  const ids = (st: ManifestStatus, exceptApproved = false) =>
    new Set(
      (rows ?? [])
        .filter(
          (r) =>
            r.status === st && !(exceptApproved && r.estado === "aprovado"),
        )
        .map((r) => r.word_id),
    );
  const itensCom = (s: Set<string>) =>
    (manifest?.itens ?? []).filter((x) => s.has(x.word_id));

  const paraImportar = ids("importar");
  const divergentes = ids("divergente");
  const paraAprovar = ids("identico", true);
  const contagem = (rows ?? []).reduce<Record<string, number>>(
    (o, r) => ((o[r.status] = (o[r.status] ?? 0) + 1), o),
    {},
  );

  return (
    <details className="panel !rounded-2xl px-3 py-2 text-xs font-display">
      <summary className="cursor-pointer text-sm">
        📋 Lote revisado (manifesto com hash)
      </summary>
      <p className="text-muted-foreground mt-2">
        Cole o manifesto do lote que você revisou. Ele fica só nesta tela. O
        servidor confere o hash de cada conjunto ao importar e ao aprovar: nada
        diferente do revisado entra no jogo.
      </p>
      <textarea
        aria-label="manifesto do lote"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder='{"versao_hash":"verbete-d1-v1","lote":1,"itens":[…]}'
        className="w-full mt-2 bg-input rounded-xl px-3 py-1.5 text-[11px] font-mono border border-white/10 outline-none"
      />
      <div className="flex gap-2 flex-wrap mt-2">
        <button
          disabled={busy || !text.trim()}
          onClick={() =>
            run(async () => {
              const p = parseManifest(text);
              if (!p.ok) {
                setManifest(null);
                setRows(null);
                return p.error;
              }
              setManifest(p.manifest);
              await conferir(p.manifest);
              return `Manifesto do lote ${p.manifest.lote ?? "?"}: ${p.manifest.itens.length} conjunto(s) conferido(s).`;
            })
          }
          className="btn-pop btn-plain text-xs !py-1.5 !px-3"
        >
          🔎 Conferir
        </button>
        {paraImportar.size > 0 && (
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await addDrafts({
                  data: {
                    rows: itensCom(paraImportar).map((x) => ({
                      wordId: x.word_id,
                      distractors: x.distractors,
                      hash: x.hash,
                    })),
                  },
                });
                return `Importados como RASCUNHO: ${r.inserted}; recusados por hash: ${r.divergent}; com aviso do validador: ${r.invalid}. Nada foi aprovado.`;
              })
            }
            className="btn-pop btn-plain text-xs !py-1.5 !px-3"
          >
            📥 Importar {paraImportar.size} como rascunho
          </button>
        )}
        {divergentes.size > 0 && (
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                let n = 0;
                for (const x of itensCom(divergentes)) {
                  const r = await edit({
                    data: { wordId: x.word_id, distractors: x.distractors },
                  });
                  n += r.updated;
                }
                return `${n} conjunto(s) substituído(s) pelo revisado (voltam a rascunho).`;
              })
            }
            className="btn-pop btn-plain text-xs !py-1.5 !px-3"
          >
            ✏️ Substituir {divergentes.size} divergente(s) pelo revisado
          </button>
        )}
        {paraAprovar.size > 0 && (
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const sel = itensCom(paraAprovar);
                const r = await review({
                  data: {
                    wordIds: sel.map((x) => x.word_id),
                    status: "aprovado",
                    expected: Object.fromEntries(
                      sel.map((x) => [x.word_id, x.hash]),
                    ),
                  },
                });
                const probs = r.problems
                  .map((p) => `• ${p.word || "?"}: ${p.reasons.join("; ")}`)
                  .join("\n");
                return `${r.updated} aprovado(s), ${r.skipped} pulado(s).${probs ? "\n" + probs : ""}`;
              })
            }
            className="btn-pop bg-gradient-mint text-accent-foreground text-xs !py-1.5 !px-3"
          >
            ✅ Aprovar {paraAprovar.size} idêntico(s)
          </button>
        )}
      </div>
      {msg && (
        <p
          role="status"
          className="mt-2 whitespace-pre-line text-muted-foreground"
        >
          {msg}
        </p>
      )}
      {rows && (
        <>
          <p className="mt-2">
            {Object.entries(contagem)
              .map(([k, n]) => `${LABEL[k as ManifestStatus]}: ${n}`)
              .join(" · ")}
          </p>
          <ul className="mt-1 max-h-64 overflow-y-auto space-y-0.5">
            {rows.map((r) => (
              <li key={r.word_id} className="flex gap-2 items-baseline">
                <span className="capitalize">{r.palavra}</span>
                <span className={TONE[r.status]}>{LABEL[r.status]}</span>
                {r.estado && (
                  <span className="text-muted-foreground">({r.estado})</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
