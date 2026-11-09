// Diário D1 — lote REVISADO fora do painel (manifesto com hash por conjunto).
// O admin cola o manifesto (não é salvo nem enviado a outro lugar); o painel
// mostra só aquelas palavras e o estado de cada uma. Importar e aprovar passam
// pelo servidor, que recalcula o hash e recusa o que divergir do revisado.
//
// Estado: o resultado da conferência (`checked`) guarda JUNTOS o manifesto e as
// linhas que vieram dele. Botões e listas saem só desse par. Qualquer edição do
// texto ou nova conferência incrementa `gen` e apaga o resultado. Respostas
// assíncronas de uma geração antiga são descartadas, mesmo que cheguem fora de
// ordem.
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import { ADMIN_PASTE_MARK } from "@/lib/paste-guard";
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
  nao_confere:
    "não confere com o revisado (manifesto alterado ou definição mudou)",
  nao_publicada: "palavra não publicada",
  inexistente: "palavra inexistente",
};
const TONE: Record<ManifestStatus, string> = {
  importar: "text-sun",
  identico: "text-mint",
  divergente: "text-destructive",
  nao_confere: "text-destructive",
  nao_publicada: "text-destructive",
  inexistente: "text-destructive",
};

export function DailyChoiceManifest({ onChanged }: { onChanged: () => void }) {
  const getByIds = useServerFn(getDailyChoicesByIds);
  const addDrafts = useServerFn(addDailyChoiceDrafts);
  const review = useServerFn(reviewDailyChoices);
  const edit = useServerFn(editDailyChoice);
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<{
    manifest: Manifest;
    rows: ManifestRow[];
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [writing, setWriting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // geração atual: tudo que voltar de uma geração anterior é jogado fora
  const gen = useRef(0);
  const invalidate = () => {
    gen.current += 1;
    setChecked(null);
    setMsg(null);
    setChecking(false);
    return gen.current;
  };

  /** Busca o estado do banco para `m` e grava o par (m, linhas) só se `g` ainda for a geração atual. */
  const conferir = async (m: Manifest, g: number): Promise<boolean> => {
    const items = (await getByIds({
      data: { wordIds: m.itens.map((x) => x.word_id) },
    })) as AdminItem[];
    const rows = await compareManifest(m, items);
    if (g !== gen.current) return false;
    setChecked({ manifest: m, rows });
    return true;
  };

  const onConferir = async () => {
    const g = invalidate();
    const p = parseManifest(text);
    if (!p.ok) {
      setMsg(p.error);
      return;
    }
    setChecking(true);
    try {
      if (await conferir(p.manifest, g))
        setMsg(
          `Manifesto do lote ${p.manifest.lote ?? "?"}: ${p.manifest.itens.length} conjunto(s) conferido(s).`,
        );
    } catch (e) {
      if (g === gen.current) setMsg(e instanceof Error ? e.message : "erro");
    } finally {
      if (g === gen.current) setChecking(false);
    }
  };

  /** Ação que grava, sempre sobre o manifesto que está NA TELA (o texto fica travado durante a gravação). */
  const write = async (m: Manifest, fn: (m: Manifest) => Promise<string>) => {
    const g = gen.current;
    setWriting(true);
    setMsg(null);
    let out: string;
    try {
      out = await fn(m);
    } catch (e) {
      // a gravação pode ter sido parcial (ex.: Substituir em laço): o resultado antigo não vale mais
      if (g === gen.current) {
        setChecked(null);
        setMsg(
          `${e instanceof Error ? e.message : "erro"}\nToque em Conferir de novo para ver o estado atual.`,
        );
      }
      setWriting(false);
      onChanged();
      return;
    }
    if (g === gen.current) setMsg(out);
    // reconfere o MESMO manifesto que foi gravado, nunca um capturado antes
    try {
      if (g === gen.current) await conferir(m, g);
    } catch (e) {
      // sem estado novo do banco, o resultado antigo não vale mais: some com ele e com os botões
      if (g === gen.current) {
        setChecked(null);
        setMsg(
          `${out}\nNão foi possível reconferir (${e instanceof Error ? e.message : "erro"}): toque em Conferir de novo.`,
        );
      }
    } finally {
      setWriting(false);
      onChanged();
    }
  };

  const rows = checked?.rows ?? null;
  /** ids com o status `st`, deixando de fora os estados em `exceto`. */
  const ids = (st: ManifestStatus, exceto: string[] = []) =>
    new Set(
      (rows ?? [])
        .filter((r) => r.status === st && !exceto.includes(r.estado ?? ""))
        .map((r) => r.word_id),
    );
  const itensCom = (m: Manifest, s: Set<string>) =>
    m.itens.filter((x) => s.has(x.word_id));
  const busy = checking || writing;

  const paraImportar = ids("importar");
  // R3: um APROVADO divergente nunca é substituído daqui (voltaria a rascunho em silêncio).
  // R4: nem um REPROVADO (voltaria a rascunho e entraria no "Aprovar idênticos").
  const divergentes = ids("divergente", ["aprovado", "reprovado"]);
  const divergentesAprovados =
    ids("divergente").size - ids("divergente", ["aprovado"]).size;
  const divergentesReprovados =
    ids("divergente").size - ids("divergente", ["reprovado"]).size;
  // R4: o lote não reaprova o que foi REPROVADO antes
  const paraAprovar = ids("identico", ["aprovado", "reprovado"]);
  const identicosReprovados =
    ids("identico").size - ids("identico", ["reprovado"]).size;
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
        onChange={(e) => {
          // texto mudou: o resultado anterior deixa de valer (e respostas em voo são descartadas)
          invalidate();
          setText(e.target.value);
        }}
        readOnly={writing}
        data-allow-paste={ADMIN_PASTE_MARK}
        rows={4}
        spellCheck={false}
        placeholder='{"versao_hash":"verbete-d1-v1","lote":1,"itens":[…]}'
        className="w-full mt-2 bg-input rounded-xl px-3 py-1.5 text-[11px] font-mono border border-white/10 outline-none"
      />
      <div className="flex gap-2 flex-wrap mt-2">
        <button
          disabled={writing || !text.trim()}
          onClick={() => void onConferir()}
          className="btn-pop btn-plain text-xs !py-1.5 !px-3"
        >
          {checking ? "⏳ Conferindo…" : "🔎 Conferir"}
        </button>
        {checked && paraImportar.size > 0 && (
          <button
            disabled={busy}
            onClick={() =>
              void write(checked.manifest, async (m) => {
                const r = await addDrafts({
                  data: {
                    rows: itensCom(m, paraImportar).map((x) => ({
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
        {checked && divergentes.size > 0 && (
          <button
            disabled={busy}
            onClick={() =>
              void write(checked.manifest, async (m) => {
                let n = 0;
                let recusados = 0;
                for (const x of itensCom(m, divergentes)) {
                  // sem allowApproved/allowRejected: se alguém aprovou ou reprovou no meio-tempo, o servidor recusa
                  const r = await edit({
                    data: { wordId: x.word_id, distractors: x.distractors },
                  });
                  n += r.updated;
                  if (r.blocked) recusados++;
                }
                return `${n} conjunto(s) substituído(s) pelo revisado (voltam a rascunho).${recusados ? ` ${recusados} recusado(s): já estava(m) APROVADO(s) ou REPROVADO(s).` : ""}`;
              })
            }
            className="btn-pop btn-plain text-xs !py-1.5 !px-3"
          >
            ✏️ Substituir {divergentes.size} divergente(s) pelo revisado
          </button>
        )}
        {checked && paraAprovar.size > 0 && (
          <button
            disabled={busy}
            onClick={() =>
              void write(checked.manifest, async (m) => {
                const sel = itensCom(m, paraAprovar);
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
      {checked &&
        (divergentesAprovados > 0 ||
          divergentesReprovados > 0 ||
          identicosReprovados > 0) && (
          <ul className="mt-2 text-sun space-y-0.5">
            {divergentesAprovados > 0 && (
              <li>
                ⚠ {divergentesAprovados} divergente(s) já APROVADO(s): não são
                substituídos daqui (voltariam a rascunho). Revise no painel
                principal.
              </li>
            )}
            {divergentesReprovados > 0 && (
              <li>
                ⚠ {divergentesReprovados} divergente(s) REPROVADO(s) antes: não
                são substituídos daqui (voltariam a rascunho e ao lote de
                aprovação). Reavalie no painel principal.
              </li>
            )}
            {identicosReprovados > 0 && (
              <li>
                ⚠ {identicosReprovados} idêntico(s) REPROVADO(s) antes: não
                entram no Aprovar em lote. Reavalie no painel principal.
              </li>
            )}
          </ul>
        )}
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
