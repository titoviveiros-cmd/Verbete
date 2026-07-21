// Fase 9 — pipeline editorial: gera palavras raras REAIS do português via
// Gemini em lotes por categoria, VERIFICA numa segunda passada de IA
// (existência + significado correto) e publica as aprovadas.
// Uso: DB_URL=... GEMINI_API_KEY=... [ALVO_POR_CATEGORIA=40] node scripts/generate-words.mjs
import pg from "pg";

const { DB_URL, GEMINI_API_KEY } = process.env;
const ALVO = Number(process.env.ALVO_POR_CATEGORIA ?? 40);
const LOTE = 20;

// Categorias visíveis no seletor do Lobby (diretriz do usuário)
const CATEGORIAS = [
  "infantil", "gastronomia", "ciencia", "planta", "animal", "corpo",
  "sentimento", "lugar", "qualidade", "adjetivo", "verbo", "direito",
  "medicina", "literatura", "nautica",
];

const ssl = /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const db = new pg.Client({ connectionString: DB_URL, ssl });
await db.connect();

const norm = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const gemini = async (system, user, model = "gemini-flash-lite-latest") => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GEMINI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      },
    );
    if (r.status === 429) {
      console.log("  429 — aguardando 30s…");
      await new Promise((res) => setTimeout(res, 30_000));
      continue;
    }
    if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const data = await r.json();
    return data?.choices?.[0]?.message?.content ?? "";
  }
  throw new Error("gemini: 429 persistente");
};

const parseJson = (content) => {
  const m = content.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : content);
};

const GEN_SYSTEM = `Você é um lexicógrafo brasileiro montando o banco de palavras do jogo "Verbete" (estilo Balderdash). Gere APENAS palavras RARAS mas REAIS do português — que constam em dicionários como Houaiss, Aurélio ou Michaelis. NUNCA invente palavras. Evite palavras de uso corrente (o jogador médio NÃO deve conhecer). Prefira raridades deliciosas de falar em voz alta.

Para cada palavra devolva um objeto JSON com:
- word: a palavra em minúsculas COM acentos corretos
- meaning: significado curto e direto (MÁXIMO 58 caracteres), sem abreviações de dicionário
- classe: substantivo | adjetivo | verbo | interjeicao | adverbio
- rarity: 2 a 5 (5 = raríssima)
- nivel: facil | medio | dificil | insano (quão difícil é adivinhar/conhecer)
- pronuncia: separação silábica com hífens (ex.: "fa-cún-di-a")
- origem: origem etimológica em poucas palavras (ex.: "do latim facundia")
- curiosidade: 1 frase curta e divertida sobre a palavra
- exemplo: 1 frase curta de uso natural
- sinonimos: array com 2 a 4 sinônimos

Devolva APENAS um array JSON de objetos, sem markdown.`;

const VERIFY_SYSTEM = `Você é um revisor lexicográfico rigoroso. Receberá uma lista de palavras com significados propostos para um jogo. Para cada uma, responda se a palavra EXISTE no português (dicionários Houaiss/Aurélio/Michaelis) E se o significado proposto está CORRETO (é o sentido principal ou um sentido legítimo). Seja rigoroso: na dúvida, REPROVE. Devolva APENAS JSON {"aprovadas": ["palavra1", ...]} com as palavras que passaram nos DOIS critérios, sem markdown.`;

let totalInseridas = 0;
let totalReprovadas = 0;

for (const cat of CATEGORIAS) {
  const { rows: existentes } = await db.query(
    `SELECT word FROM public.words WHERE category = $1`, [cat]);
  const jaTem = existentes.length;
  const faltam = Math.max(0, ALVO - jaTem);
  if (faltam === 0) {
    console.log(`\n== ${cat}: já tem ${jaTem}, pulando`);
    continue;
  }
  console.log(`\n== ${cat}: tem ${jaTem}, gerando ~${faltam}`);
  const evitarSet = new Set(existentes.map((r) => norm(r.word)));

  let inseridasCat = 0;
  for (let lote = 0; lote < Math.ceil(faltam / LOTE) && inseridasCat < faltam; lote++) {
    const pedir = Math.min(LOTE, faltam - inseridasCat + 4); // margem p/ reprovações
    const { rows: todas } = await db.query(`SELECT word FROM public.words`);
    const evitarGlobal = todas.map((r) => r.word).join(", ");
    const user = `Categoria/tema: ${cat}\nGere ${pedir} palavras raras REAIS deste tema.\nNÃO use nenhuma destas (já temos): ${evitarGlobal}`;

    let candidatas = [];
    try {
      candidatas = parseJson(await gemini(GEN_SYSTEM, user));
    } catch (e) {
      console.log(`  lote ${lote + 1}: geração falhou (${String(e).slice(0, 90)})`);
      continue;
    }
    candidatas = (Array.isArray(candidatas) ? candidatas : [])
      .filter(
        (c) =>
          c && typeof c.word === "string" && typeof c.meaning === "string" &&
          c.word.length >= 3 && c.meaning.length > 5 &&
          c.meaning.length <= 60 && !evitarSet.has(norm(c.word)),
      );
    if (candidatas.length === 0) {
      console.log(`  lote ${lote + 1}: 0 candidatas válidas`);
      continue;
    }

    // Passada 2: verificação de existência + correção
    let aprovadas = [];
    try {
      const lista = candidatas
        .map((c) => `- ${c.word}: ${c.meaning}`)
        .join("\n");
      const out = parseJson(
        await gemini(VERIFY_SYSTEM, `Verifique:\n${lista}`),
      );
      const setA = new Set((out.aprovadas ?? []).map((w) => norm(String(w))));
      aprovadas = candidatas.filter((c) => setA.has(norm(c.word)));
    } catch (e) {
      console.log(`  lote ${lote + 1}: verificação falhou (${String(e).slice(0, 90)}) — lote descartado`);
      continue;
    }
    totalReprovadas += candidatas.length - aprovadas.length;

    for (const c of aprovadas) {
      if (inseridasCat >= faltam) break;
      const nivel = ["facil", "medio", "dificil", "insano"].includes(c.nivel)
        ? c.nivel
        : "dificil";
      const rarity = Math.min(5, Math.max(2, Number(c.rarity) || 3));
      const sin = Array.isArray(c.sinonimos)
        ? c.sinonimos.map(String).slice(0, 4)
        : [];
      try {
        const { rowCount } = await db.query(
          `INSERT INTO public.words
             (word, meaning, category, rarity, nivel, classe, pronuncia, origem, curiosidade, exemplo, sinonimos, status, review_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'published','IA: gerada e verificada em dupla passada (lote 2026-07-22)')
           ON CONFLICT (word) DO NOTHING`,
          [
            String(c.word).toLowerCase().trim(),
            String(c.meaning).trim(),
            cat,
            rarity,
            nivel,
            String(c.classe ?? "substantivo").slice(0, 20),
            String(c.pronuncia ?? "").slice(0, 60),
            String(c.origem ?? "").slice(0, 120),
            String(c.curiosidade ?? "").slice(0, 200),
            String(c.exemplo ?? "").slice(0, 160),
            sin,
          ],
        );
        if (rowCount > 0) {
          inseridasCat++;
          totalInseridas++;
          evitarSet.add(norm(c.word));
          console.log(`  + ${c.word} (${nivel}) — ${c.meaning}`);
        }
      } catch (e) {
        console.log(`  ! ${c.word}: ${String(e).slice(0, 80)}`);
      }
    }
    await new Promise((res) => setTimeout(res, 1200));
  }
}

const { rows: [tot] } = await db.query(
  `SELECT count(*)::int AS n FROM public.words WHERE status = 'published'`);
console.log(`\n=== FIM: +${totalInseridas} publicadas (${totalReprovadas} reprovadas na verificação). Total publicado: ${tot.n}`);
await db.end();
