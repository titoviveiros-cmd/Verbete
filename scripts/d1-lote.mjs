#!/usr/bin/env node
// D1 — conferência OFFLINE de lotes do modo escolha + manifesto a partir das decisões
// do revisor. Não acessa rede nem banco; não grava, não aprova. Node ≥ 22.18 (ou 24).
//
//   node scripts/d1-lote.mjs conferir --acervo <acervo.json> --conjuntos <lote.json>
//        [--conjuntos <reservas.json>] [--extras <extras.json>] [--duvidas <duvidas.json>]
//        --saida <pasta>
//     → relatorio.json, relatorio.csv, RELATORIO.md, conjuntos.json,
//       REVISAO-LOTE-<n>.csv (um por lote) e REVISAO-TODOS.csv (planilha do revisor)
//
//   node scripts/d1-lote.mjs manifesto --relatorio <pasta>/relatorio.json
//        --decisoes <REVISAO-LOTE-1.csv preenchida | decisoes-d1.json> --lote 1 --saida <pasta>
//     → manifesto-lote-1.json (só "aprovar" com hash conferido e sem BLOQUEIA)
//
// O status nunca passa de PENDENTE: quem decide é a leitura humana, e quem aprova é
// o admin no painel /admin/daily-choices (Conferir → Importar → Aprovar idênticos).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ALERTAS,
  COLUNAS_REVISAO,
  conferirLote,
  lerAcervo,
  lerConjuntos,
  lerDecisoes,
  lerExtras,
  gravarManifesto,
  linhasRevisao,
  loteValido,
  montarManifesto,
  paraCsv,
} from "./lib/d1-lote.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  if (!k?.startsWith("--")) continue;
  const v = rest[i + 1];
  i++;
  (args[k.slice(2)] ??= []).push(v);
}
const um = (k, obrig = true) => {
  const v = args[k]?.[0];
  if (obrig && !v) {
    console.error(`✖ falta --${k}`);
    process.exit(2);
  }
  return v;
};
const lerJson = (p) =>
  JSON.parse(readFileSync(resolve(p), "utf8").replace(/^﻿/, ""));

if (cmd === "conferir") {
  const acervo = lerAcervo(lerJson(um("acervo")));
  const extras = args.extras ? lerExtras(lerJson(um("extras"))) : undefined;
  const duvidas = args.duvidas ? lerJson(um("duvidas")) : {};
  const conjuntos = (args.conjuntos ?? []).flatMap((p) =>
    lerConjuntos(lerJson(p)),
  );
  if (!conjuntos.length) {
    console.error("✖ falta --conjuntos");
    process.exit(2);
  }
  const saida = resolve(um("saida"));
  mkdirSync(saida, { recursive: true });
  const rel = await conferirLote(conjuntos, { acervo, extras, duvidas });
  const meta = {
    gerado_em: new Date().toISOString(),
    acervo_palavras: acervo.length,
    arquivos: {
      acervo: um("acervo"),
      conjuntos: args.conjuntos,
      extras: args.extras ?? null,
      duvidas: args.duvidas ?? null,
    },
    aviso:
      "Conferência automática OFFLINE. PENDENTE = sem alerta automático, NÃO quer dizer correto. Nada foi gravado nem aprovado.",
  };
  writeFileSync(
    join(saida, "relatorio.json"),
    JSON.stringify({ meta, ...rel }, null, 1),
  );
  writeFileSync(
    join(saida, "conjuntos.json"),
    JSON.stringify(
      rel.conjuntos.map((c) => ({
        lote: c.lote,
        n: c.n,
        word_id: c.word_id,
        palavra: c.palavra,
        definicao: c.definicao,
        alternativas: c.alternativas,
        hash: c.hash,
      })),
    ),
  );
  writeFileSync(
    join(saida, "relatorio.csv"),
    paraCsv(
      [
        "lote",
        "nº",
        "palavra",
        "status",
        "BLOQUEIA",
        "REVISAR",
        "códigos",
        "detalhes",
        "word_id",
        "hash",
      ],
      rel.conjuntos.map((c) => [
        c.lote,
        c.n,
        c.palavra,
        c.status,
        c.bloqueia,
        c.revisar,
        [...new Set(c.alertas.map((a) => a.codigo))].join(" "),
        c.alertas
          .map((a) => `${a.nivel} ${a.codigo}: ${a.detalhe || a.texto}`)
          .join(" | "),
        c.word_id,
        c.hash,
      ]),
    ),
  );
  const lotes = [...new Set(rel.conjuntos.map((c) => c.lote))].map(loteValido);
  for (const l of lotes)
    writeFileSync(
      join(saida, `REVISAO-LOTE-${l}.csv`),
      paraCsv(
        COLUNAS_REVISAO,
        linhasRevisao(rel.conjuntos.filter((c) => c.lote === l)),
      ),
    );
  writeFileSync(
    join(saida, "REVISAO-TODOS.csv"),
    paraCsv(COLUNAS_REVISAO, linhasRevisao(rel.conjuntos)),
  );
  writeFileSync(join(saida, "RELATORIO.md"), relatorioMd(meta, rel));
  const r = rel.resumo;
  console.log(
    `${r.total} conjuntos: ${JSON.stringify(r.por_status)}; com BLOQUEIA: ${r.com_bloqueio}`,
  );
  console.log(`saída: ${saida}`);
} else if (cmd === "manifesto") {
  const rel = lerJson(um("relatorio"));
  const dec = lerDecisoes(readFileSync(resolve(um("decisoes")), "utf8"));
  const lote = loteValido(um("lote"));
  const saida = resolve(um("saida"));
  mkdirSync(saida, { recursive: true });
  const { manifesto, fora } = await montarManifesto(rel, dec, lote);
  const g = gravarManifesto(saida, lote, manifesto);
  console.log(
    g.gravado
      ? `${g.arquivo}: ${manifesto.itens.length} para importar/aprovar no painel`
      : "nenhum conjunto aprovado com hash conferido: manifesto NÃO gerado",
  );
  if (g.apagouAntigo)
    console.log(
      `⚠ manifesto ANTIGO deste lote APAGADO (${g.arquivo}): não use cópias dele no painel`,
    );
  console.log(`fora do manifesto: ${fora.length}`);
  for (const f of fora) console.log(`  - ${f.palavra}: ${f.motivo}`);
} else {
  console.error(
    "uso: node scripts/d1-lote.mjs conferir|manifesto … (ver cabeçalho do arquivo)",
  );
  process.exit(2);
}

function relatorioMd(meta, rel) {
  const r = rel.resumo;
  const linhas = [];
  linhas.push("# Conferência automática do lote D1 (offline)", "");
  linhas.push(`> ${meta.aviso}`, "");
  linhas.push(
    `Gerado em ${meta.gerado_em} · acervo com ${meta.acervo_palavras} palavras publicadas (snapshot do arquivo, não do banco de hoje).`,
    "",
  );
  linhas.push(
    `**${r.total} conjuntos** — PENDENTE ${r.por_status.PENDENTE ?? 0} · ALERTA ${r.por_status.ALERTA ?? 0} · com BLOQUEIA ${r.com_bloqueio}`,
    "",
  );
  linhas.push(
    "## Por lote",
    "",
    "| lote | total | PENDENTE | ALERTA | com BLOQUEIA |",
    "|---|---|---|---|---|",
  );
  for (const [l, v] of Object.entries(r.por_lote))
    linhas.push(
      `| ${l} | ${v.total} | ${v.PENDENTE} | ${v.ALERTA} | ${v.com_bloqueio} |`,
    );
  linhas.push(
    "",
    "## Por tipo de alerta",
    "",
    "| nível | código | conjuntos | ocorrências | o que é |",
    "|---|---|---|---|---|",
  );
  const ordem = { BLOQUEIA: 0, REVISAR: 1, INFO: 2 };
  for (const [cod, [nivel, texto]] of Object.entries(ALERTAS).sort(
    (a, b) => ordem[a[1][0]] - ordem[b[1][0]],
  ))
    linhas.push(
      `| ${nivel} | \`${cod}\` | ${r.conjuntos_por_codigo[cod] ?? 0} | ${r.alertas_por_codigo[cod] ?? 0} | ${texto} |`,
    );
  const bloq = rel.conjuntos.filter((c) => c.bloqueia);
  linhas.push("", "## Conjuntos com BLOQUEIA", "");
  if (!bloq.length) linhas.push("Nenhum.");
  for (const c of bloq)
    linhas.push(
      `- lote ${c.lote} nº ${c.n} **${c.palavra}**: ${c.alertas
        .filter((a) => a.nivel === "BLOQUEIA")
        .map((a) => `${a.codigo} (${a.detalhe})`)
        .join("; ")}`,
    );
  linhas.push("", "## Limites da conferência", "");
  linhas.push(
    "- Heurística não lê sentido: não detecta sozinha uma alternativa que TAMBÉM define a palavra (fora dos sinônimos registrados e das entradas de mesma grafia), nem um distrator absurdo do mesmo campo.",
    '- `definicao_mudou` compara com o acervo DO ARQUIVO. No dia da importação, o "🔎 Conferir" do painel recalcula o hash com a definição ATUAL do banco e marca "não confere" o que mudou (falha fechada).',
    '- Status nunca é "aprovado": PENDENTE só quer dizer que nenhuma regra automática disparou.',
  );
  return linhas.join("\n") + "\n";
}
