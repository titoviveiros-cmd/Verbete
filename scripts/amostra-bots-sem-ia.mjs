// Amostra e métricas "antes × depois" dos bots SEM IA externa (10/11/2026).
// Antes = 62 reservas fixas (bot-definitions-v2/reserves.ts); depois = gerador
// local (bot-definitions/offline.ts). Sem rede e sem banco: o acervo é o dos
// seeds versionados (180 palavras). Determinístico (sementes fixas).
//
//   node scripts/amostra-bots-sem-ia.mjs [saida.md]
//
// Node 24+ (importa .ts direto, com remoção de tipos).
import { readFileSync, writeFileSync } from "node:fs";
import {
  dice,
  normTxt,
  vetReserves,
} from "../supabase/functions/bot-definitions/logic.ts";
import {
  generateOfflineCandidates,
  inferWordClass,
  seededRng,
  truthGuard,
  truthIssue,
} from "../supabase/functions/bot-definitions/offline.ts";
import { pickReserves } from "../supabase/functions/bot-definitions-v2/reserves.ts";

const WORDS = [];
for (const f of [
  "supabase/migrations/20260713111000_words_seed_v2.sql",
  "supabase/migrations/20260721160000_words_seed_v3.sql",
]) {
  const re =
    /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*\d+\s*,\s*'((?:[^']|'')*)'/g;
  for (const m of readFileSync(f, "utf8").matchAll(re))
    WORDS.push({
      word: m[1].replace(/''/g, "'"),
      meaning: m[2].replace(/''/g, "'"),
      category: m[3],
      classe: m[4],
    });
}

/** Fila dos bots como a edge monta (reservas → vetReserves), 3 bots. */
function legacy(w, seed, previous = []) {
  return vetReserves(pickReserves(12, seededRng(seed)), {
    word: w.word,
    meaning: w.meaning,
    previous,
    servedNorms: [],
  }).slice(0, 3);
}
function offline(w, seed, previous = []) {
  const cands = generateOfflineCandidates({ ...w, count: 12, seed, avoid: previous });
  const texts = vetReserves(
    cands.map((c) => c.text),
    { word: w.word, meaning: w.meaning, previous, servedNorms: [] },
  ).slice(0, 3);
  return texts.map((t) => cands.find((c) => c.text === t));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (a, b) => `${((100 * a) / b).toFixed(1)}%`;

// 1) Variedade: 30 palavras × 30 chamadas × 3 bots
const sample = WORDS.filter((_, i) => i % 6 === 0);
const variety = { old: new Set(), neu: new Set(), total: 0 };
for (const w of sample)
  for (let i = 0; i < 30; i++) {
    legacy(w, `v${i}:${w.word}`).forEach((t) => variety.old.add(normTxt(t)));
    offline(w, `v${i}:${w.word}`).forEach((c) => variety.neu.add(normTxt(c.text)));
    variety.total += 3;
  }

// 2) Partidas: 40 partidas × 10 rodadas × 3 bots. Repetição dentro da partida
// (Dice > 0,5 com o que um bot já disse) e "reconhecível" = texto (ou, no
// gerador, o trecho principal do banco) já visto nas 5 partidas anteriores.
const matches = { old: [], neu: [] };
const starve = { old: 0, neu: 0 };
for (let m = 0; m < 40; m++) {
  for (const kind of ["old", "neu"]) {
    const previous = [];
    const seen = [];
    for (let r = 1; r <= 10; r++) {
      const w = WORDS[(m * 17 + r * 31) % WORDS.length];
      const seed = `m${m}:r${r}`;
      const got =
        kind === "old"
          ? legacy(w, seed, previous).map((t) => ({ text: t, parts: [t] }))
          : offline(w, seed, previous);
      starve[kind] += 3 - got.length;
      for (const g of got) {
        seen.push(g);
        previous.push(g.text);
      }
    }
    matches[kind].push(seen);
  }
}
function matchStats(kind) {
  let rep = 0;
  let total = 0;
  let recogText = 0;
  let recogPart = 0;
  matches[kind].forEach((seen, m) => {
    seen.forEach((g, i) => {
      total++;
      const n = normTxt(g.text);
      if (seen.slice(0, i).some((p) => dice(normTxt(p.text), n) > 0.5)) rep++;
    });
    if (m < 5) return;
    const hist = matches[kind].slice(m - 5, m).flat();
    const texts = new Set(hist.map((g) => normTxt(g.text)));
    const parts = new Set(hist.flatMap((g) => g.parts.map(normTxt)));
    for (const g of seen) {
      if (texts.has(normTxt(g.text))) recogText++;
      if (g.parts.some((p) => parts.has(normTxt(p)))) recogPart++;
    }
  });
  const evaluated = matches[kind].slice(5).flat().length;
  return { rep, total, recogText, recogPart, evaluated };
}
const ms = { old: matchStats("old"), neu: matchStats("neu") };

// 3) Tamanho, classe e vazamento (180 palavras × 10 chamadas × 3)
const size = { truth: [], old: [], neu: [] };
const cls = { verbo: [0, 0, 0], adjetivo: [0, 0, 0] }; // [n, ok_old, ok_new]
const leak = { old: 0, neu: 0, n: 0 };
const INF = /^[a-zà-ú-]+(ar|er|ir|or)(-se)?,?$/;
const ADJ = /^(que|relativo|proprio|tipico|diz|cheio)$/;
for (const w of WORDS) {
  size.truth.push(w.meaning.length);
  const k = inferWordClass(w);
  const g = truthGuard(w.meaning);
  for (let i = 0; i < 10; i++) {
    const o = legacy(w, `s${i}`);
    const n = offline(w, `s${i}`).map((c) => c);
    o.forEach((t) => size.old.push(t.length));
    n.forEach((c) => size.neu.push(c.text.length));
    for (let j = 0; j < 3; j++) {
      leak.n++;
      if (o[j] && truthIssue(o[j], g)) leak.old++;
      if (n[j] && truthIssue(n[j].text, g)) leak.neu++;
      if (k === "verbo") {
        cls.verbo[0]++;
        if (o[j] && INF.test(o[j].split(" ")[0].toLowerCase())) cls.verbo[1]++;
        if (n[j] && (INF.test(n[j].text.split(" ")[0].toLowerCase()) || n[j].text.startsWith("tornar"))) cls.verbo[2]++;
      }
      if (k === "adjetivo") {
        cls.adjetivo[0]++;
        const f = (t) => ADJ.test(normTxt(t).split(" ")[0]);
        if (o[j] && f(o[j])) cls.adjetivo[1]++;
        if (n[j] && (f(n[j].text) || n[j].via === "adj-par")) cls.adjetivo[2]++;
      }
    }
  }
}

// 4) Desempenho (12 por pedido, como a edge)
let t0 = performance.now();
for (let i = 0; i < 2000; i++)
  generateOfflineCandidates({ ...WORDS[i % WORDS.length], count: 12, seed: `p${i}` });
const perReq = (performance.now() - t0) / 2000;

// ---------------------------------------------------------------------------
const L = [];
L.push("# Amostra — bots sem IA externa (antes × depois)", "");
L.push(
  "> Gerado por `node scripts/amostra-bots-sem-ia.mjs` (determinístico, sem rede, sem banco).",
  "> Acervo: 180 palavras dos seeds versionados (`words_seed_v2` + `words_seed_v3`). Produção tem ~836: NÃO usado.",
  "> **Antes** = 62 reservas fixas pela cadeia `vetReserves` (o que a edge v2 devolve com a IA suspensa).",
  "> **Depois** = gerador local (`offline.ts`) pela mesma cadeia. Conteúdo do banco: **PENDENTE REVISÃO EDITORIAL**.",
  "",
);
L.push("## Métricas", "");
L.push("| Métrica | Antes (62 fixas) | Depois (gerador) |", "|---|---|---|");
L.push(
  `| Definições distintas em ${variety.total} (30 palavras × 30 chamadas × 3) | ${variety.old.size} | ${variety.neu.size} |`,
);
L.push(
  `| Repetição dentro da partida (Dice > 0,5; 40 partidas × 10 rodadas × 3 bots) | ${ms.old.rep}/${ms.old.total} | ${ms.neu.rep}/${ms.neu.total} |`,
);
L.push(`| Bots sem linha por falta de reserva (mesmas partidas) | ${starve.old} | ${starve.neu} |`);
L.push(
  `| Texto IDÊNTICO a um já visto nas 5 partidas anteriores | ${pct(ms.old.recogText, ms.old.evaluated)} | ${pct(ms.neu.recogText, ms.neu.evaluated)} |`,
);
L.push(
  `| Trecho principal (complemento/ação/par) já visto nas 5 partidas anteriores | ${pct(ms.old.recogPart, ms.old.evaluated)} | ${pct(ms.neu.recogPart, ms.neu.evaluated)} |`,
);
L.push(
  `| Mediana de caracteres (verdade = ${median(size.truth)}) | ${median(size.old)} | ${median(size.neu)} |`,
);
L.push(
  `| Verbos: definição começa por infinitivo (${cls.verbo[0]} casos) | ${pct(cls.verbo[1], cls.verbo[0])} | ${pct(cls.verbo[2], cls.verbo[0])} |`,
);
L.push(
  `| Adjetivos: molde de qualidade (${cls.adjetivo[0]} casos) | ${pct(cls.adjetivo[1], cls.adjetivo[0])} | ${pct(cls.adjetivo[2], cls.adjetivo[0])} |`,
);
L.push(
  `| Toca a verdade (raiz/campo semântico/Dice) — ${leak.n} casos | ${leak.old} | ${leak.neu} |`,
);
L.push(`| Tempo por pedido de 12 (Node, esta máquina) | ~0 ms | ${perReq.toFixed(2)} ms |`, "");

L.push("## Amostra: 30 palavras × 3 definições", "");
L.push("| Palavra (classe · categoria) | Verdade | Antes (62 fixas) | Depois (gerador) |", "|---|---|---|---|");
for (const w of sample) {
  const o = legacy(w, `amostra:${w.word}`);
  const n = offline(w, `amostra:${w.word}`);
  const cell = (xs) => xs.map((x) => `• ${x}`).join("<br>");
  L.push(
    `| **${w.word}** (${w.classe} · ${w.category}) | ${w.meaning} | ${cell(o)} | ${cell(n.map((c) => `${c.text} <sub>${c.via}</sub>`))} |`,
  );
}
L.push("");
const out = process.argv[2];
if (out) writeFileSync(out, L.join("\n"), "utf8");
else console.log(L.join("\n"));
