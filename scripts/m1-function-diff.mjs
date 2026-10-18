// Evidência de que o M1 não mexe em pontuação nem em regra de tempo.
// Lê só as migrations do repositório (nenhum banco):
//   1) lista as funções que pontuam ou fixam prazo de fase e diz se o M1 as
//      redefine;
//   2) para cada função que o M1 redefine, conta as linhas que entraram/saíram
//      e mostra as que pontuam ou fixam prazo.
// Uso: node scripts/m1-function-diff.mjs   (sai com 1 se alguma dessas mudou)
import { readFileSync, readdirSync } from "node:fs";

const DIR = "supabase/migrations";
const M1 = "20261003";

// pontuação: soma/atribuição de score, XP, contagem de coordenador
const SCORE_RE = /\bscore\s*=|\bscore\s*\+|\bxp\b|\bxp_|coordinator_count\s*=/i;
// tempo de jogo: duração de fase e definição de prazo (não filtros de WHERE)
const TIME_RE = /phase_secs\s*\(|round_phase_ends_at\s*:?=|writing_extended/i;

const defs = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".sql")).sort()) {
  const sql = readFileSync(`${DIR}/${f}`, "utf8");
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?\s*\(/gi;
  for (const m of sql.matchAll(re)) {
    // sobrecargas (ex.: apply_similarity_bonus com 3 e com 1 argumento) são
    // funções distintas: a chave leva o número de argumentos
    let depth = 0;
    let args = 0;
    let any = false;
    for (let i = m.index + m[0].length; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "(") depth++;
      else if (ch === ")" && depth-- === 0) break;
      else if (ch === "," && depth === 0) args++;
      else if (!/\s/.test(ch)) any = true;
    }
    const arity = any ? args + 1 : 0;
    const as = sql.slice(m.index).match(/\bAS\s+(\$[a-z_]*\$)/i);
    if (!as) continue;
    const start = m.index + as.index + as[0].length;
    const end = sql.indexOf(as[1], start);
    if (end < 0) continue;
    const lines = sql
      .slice(start, end)
      .split("\n")
      .map((l) => l.replace(/--.*$/, "").trim())
      .filter(Boolean);
    defs.push({ name: `${m[1].toLowerCase()}/${arity}`, file: f, m1: f >= M1, lines });
  }
}
const latest = (name, m1) => defs.filter((d) => d.name === name && d.m1 === m1).at(-1);
const names = [...new Set(defs.map((d) => d.name))].sort();
const m1Names = names.filter((n) => latest(n, true));
const rule = (l) => SCORE_RE.test(l) || TIME_RE.test(l);

console.log("1) Funções que pontuam ou fixam prazo de fase (versão pré-M1)");
for (const n of names) {
  const pre = latest(n, false);
  if (!pre) continue;
  const s = pre.lines.filter((l) => SCORE_RE.test(l)).length;
  const t = pre.lines.filter((l) => TIME_RE.test(l)).length;
  if (!s && !t) continue;
  const again = m1Names.includes(n);
  console.log(
    `   ${again ? "↻" : "✅"} ${n.padEnd(32)} pontuação:${String(s).padStart(2)}  prazo:${String(t).padStart(2)}  ${again ? "redefinida no M1 → ver item 2" : "intocada pelo M1"}`,
  );
}

console.log("\n2) Funções redefinidas pelo M1");
let changed = 0;
for (const n of m1Names) {
  const pre = latest(n, false);
  const post = latest(n, true);
  if (!pre) {
    const hits = post.lines.filter(rule);
    changed += hits.length;
    console.log(`   🆕 ${n.padEnd(32)} nova  linhas que pontuam/fixam prazo: ${hits.length}`);
    for (const l of hits) console.log(`        + ${l.slice(0, 140)}`);
    continue;
  }
  const add = post.lines.filter((l) => !pre.lines.includes(l));
  const del = pre.lines.filter((l) => !post.lines.includes(l));
  const hits = [...add.map((l) => `+ ${l}`), ...del.map((l) => `- ${l}`)].filter((l) => rule(l.slice(2)));
  changed += hits.length;
  console.log(
    `   ${hits.length ? "❌" : "✅"} ${n.padEnd(32)} +${String(add.length).padStart(2)} -${String(del.length).padStart(2)}  linhas que pontuam/fixam prazo alteradas: ${hits.length}`,
  );
  for (const l of hits) console.log(`        ${l.slice(0, 140)}`);
}
console.log(
  changed
    ? `\n${changed} linha(s) de pontuação/prazo mudaram — revisar`
    : "\nNENHUMA linha que pontua ou fixa prazo mudou no M1",
);
process.exit(changed ? 1 : 0);
