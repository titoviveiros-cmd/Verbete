// Edge function: gera definições falsas plausíveis para bots usando Gemini Flash (Google AI).
// Recebe { word_id, count, personas? } e devolve { definitions: string[] }.
// IMPORTANTE: o significado da palavra é buscado AQUI (service role), nunca aceito
// do cliente — assim ele não trafega no navegador e não pode ser usado para cheating.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PERSONA_PROMPTS: Record<string, string> = {
  conciso:
    "estilo dicionário enxuto: 4 a 8 palavras, núcleo da ideia + 1 traço distintivo. NUNCA use abreviações (s.m., adj., v.) nem parênteses iniciais.",
  analitico:
    "estilo dicionário clássico (gênero próximo + diferença específica): nomeie a categoria geral e adicione UM detalhe que distingue. 6 a 12 palavras. Sem abreviações.",
  funcional:
    "estilo dicionário voltado ao uso: defina pelo que a coisa faz, serve ou produz. 5 a 10 palavras, direto. Sem abreviações.",
  descritivo:
    "estilo dicionário descritivo: foque na forma, aspecto ou característica visível mais marcante. 6 a 11 palavras. Sem abreviações.",
  contextual:
    "estilo dicionário com domínio: comece indicando o campo de uso (em culinária, em botânica, em musica, etc.) seguido de definição curta. 6 a 12 palavras. Sem abreviações.",
  comparativo:
    "estilo dicionário por semelhança: defina relacionando a algo conhecido ('semelhante a...', 'tipo de...', 'variedade de...'). 6 a 11 palavras. Sem abreviações.",
  acepcao:
    "estilo dicionário de acepção secundária: defina como se fosse um sentido figurado ou menos comum, ainda enxuto. 5 a 10 palavras. Sem abreviações.",
  popular:
    "estilo dicionário em registro popular brasileiro: definição curta, vocabulário comum, sem gírias marcadas. 5 a 9 palavras. Sem abreviações.",
};

const DEFAULT_PERSONAS = ["conciso", "analitico", "funcional", "descritivo", "contextual", "comparativo", "acepcao", "popular"];


const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Gate por CONTEXTO DE JOGO em vez de login: convidados são o público
  // principal e a exigência de JWT fazia TODA geração cair no fallback de
  // templates (causa das definições repetidas do playtest). Abuso é contido
  // adiante: a palavra pedida precisa ser a palavra CORRENTE de uma sala em
  // fase de escrita — fora disso, 403.
  try {
    const body = await req.json();
    const wordId = typeof body?.word_id === "string" ? body.word_id : "";
    const personas = body?.personas;
    if (!wordId) {
      return new Response(JSON.stringify({ error: "word_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const count = Math.min(Math.max(1, Number(body?.count) || 3), 10);

    // Busca palavra + significado server-side (service role), tentando words depois room_words.
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Validação de contexto: só gera para a palavra corrente de uma sala
    // em fase de escrita/embaralhamento (substitui o gate de login).
    const { data: activeRoom } = await admin
      .from("rooms")
      .select("id")
      .eq("current_word_id", wordId)
      .in("status", ["writing", "shuffling"])
      .limit(1)
      .maybeSingle();
    if (!activeRoom) {
      return new Response(JSON.stringify({ error: "no_active_round_for_word", definitions: [] }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let word = "";
    let meaning = "";
    let category = "";
    const { data: w1 } = await admin.from("words").select("word, meaning, category").eq("id", wordId).maybeSingle();
    if (w1) {
      word = String((w1 as any).word ?? "").slice(0, 200);
      meaning = String((w1 as any).meaning ?? "").slice(0, 400);
      category = String((w1 as any).category ?? "").slice(0, 40).toLowerCase();
    } else {
      const { data: w2 } = await admin.from("room_words").select("word, meaning, category").eq("id", wordId).maybeSingle();
      if (w2) {
        word = String((w2 as any).word ?? "").slice(0, 200);
        meaning = String((w2 as any).meaning ?? "").slice(0, 400);
        category = String((w2 as any).category ?? "").slice(0, 40).toLowerCase();
      }
    }
    if (!word) {
      return new Response(JSON.stringify({ error: "word not found", definitions: [] }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");

    // Garante uma persona por definição (rotaciona se faltar)
    const chosen: string[] = Array.from({ length: count }, (_, i) => {
      const fromClient = Array.isArray(personas) ? personas[i] : undefined;
      return (fromClient && PERSONA_PROMPTS[fromClient]) ? fromClient : DEFAULT_PERSONAS[i % DEFAULT_PERSONAS.length];
    });

    // Regras gramaticais por categoria — força os bots a respeitarem o tipo da palavra.
    const CATEGORY_RULES: Record<string, string> = {
      verbo: "A palavra é um VERBO. Toda definição deve descrever uma AÇÃO (comece por verbo no infinitivo: 'fazer...', 'mover...', 'cortar...'). NUNCA defina como objeto, lugar ou pessoa.",
      acao: "A palavra é uma AÇÃO. Defina como verbo no infinitivo ou frase de ação curta. NUNCA como objeto ou ser.",
      "ação": "A palavra é uma AÇÃO. Defina como verbo no infinitivo ou frase de ação curta. NUNCA como objeto ou ser.",
      adjetivo: "A palavra é um ADJETIVO (qualidade). Defina como característica/qualidade ('que é...', 'relativo a...'). NUNCA como objeto, ação ou pessoa.",
      qualidade: "A palavra é uma QUALIDADE/ADJETIVO. Defina como característica ('que é...', 'aquilo que tem...'). NUNCA como objeto físico ou ação concreta.",
      substantivo: "A palavra é um SUBSTANTIVO. Defina como uma coisa, conceito ou ser. NUNCA comece com verbo no infinitivo descrevendo ação.",
      objeto: "A palavra é um OBJETO/COISA física. Defina como item, utensílio ou artefato concreto. NUNCA como ação, sentimento ou pessoa.",
      animal: "A palavra é um ANIMAL. Defina como bicho/ser vivo (ex.: 'pequeno mamífero...', 'ave que...'). NUNCA como objeto, planta ou ação.",
      planta: "A palavra é uma PLANTA. Defina como vegetal/flora (ex.: 'arbusto de...', 'planta usada para...'). NUNCA como animal, objeto ou ação.",
      lugar: "A palavra é um LUGAR. Defina como local geográfico ou tipo de ambiente. NUNCA como objeto portátil, animal ou ação.",
      pessoa: "A palavra designa uma PESSOA/profissão/tipo humano. Defina como 'aquele que...' ou 'pessoa que...'. NUNCA como objeto ou animal.",
      sentimento: "A palavra é um SENTIMENTO/emoção. Defina como estado emocional ou afetivo. NUNCA como objeto físico, animal ou ação concreta.",
      comportamento: "A palavra é um COMPORTAMENTO/atitude. Defina como modo de agir ou postura. NUNCA como objeto físico.",
      natureza: "A palavra pertence à NATUREZA (fenômeno, elemento natural). Defina coerentemente com isso. NUNCA como objeto fabricado.",
      gastronomia: "A palavra é de GASTRONOMIA (comida, prato, ingrediente). Defina como alimento/preparo. NUNCA como animal vivo, objeto não-comestível ou ação.",
      corpo: "A palavra se refere ao CORPO humano (parte/órgão). Defina como parte anatômica. NUNCA como objeto externo, animal ou ação.",
      ciencia: "A palavra é da CIÊNCIA (termo técnico, fenômeno). Defina coerentemente como conceito/fenômeno. NUNCA como objeto cotidiano banal.",
      regional: "A palavra é um termo REGIONAL brasileiro. Defina com sabor local mantendo o tipo gramatical correto.",
      cotidiano: "A palavra é do COTIDIANO. Mantenha-se coerente com o tipo provável (objeto, ação, conceito) sugerido pela palavra.",
      "situação": "A palavra descreve uma SITUAÇÃO/circunstância. Defina como contexto ou cenário. NUNCA como objeto físico isolado.",
    };
    const categoryRule = category && CATEGORY_RULES[category]
      ? `\n\nREGRA GRAMATICAL OBRIGATÓRIA (categoria: ${category}):\n${CATEGORY_RULES[category]}`
      : "";

    const personaInstructions = chosen
      .map((p, i) => `${i + 1}. estilo "${p}": ${PERSONA_PROMPTS[p]}`)
      .join("\n");

    const system = `Você é um lexicógrafo escrevendo verbetes de dicionário para o jogo "Verbete" (Balderdash em português). Para cada palavra rara, escreva ${count} definições FALSAS, plausíveis, em ESTILO DE DICIONÁRIO: enxutas, neutras, sem exemplos, sem "que serve para", sem rodeios. Idealmente 5 a 11 palavras, NUNCA mais que 13. Cada definição usa um ESTILO diferente (estrutura/registro variados) para parecer escrita por verbetistas distintos — VARIE as construções iniciais: evite começar todas com "que..." ou "aquele que...".

REGRA MAIS IMPORTANTE — a definição deve ser INCORRETA: se um professor de português a visse como resposta para a palavra, deveria marcá-la como ERRADA. É PROIBIDO: repetir a verdadeira, sinônimos dela, paráfrases, versões resumidas ou ampliadas, ou qualquer formulação que capture a MESMA ideia (ex.: se a verdade é "desse modo, assim sendo", então "por conseguinte" é PROIBIDO por ser sinônimo). Escolha um conceito VIZINHO mas claramente DISTINTO: outra função, outro domínio, outro objeto.

Tudo em minúsculas, SEM acentos. NUNCA use abreviações (s.m., s.f., adj., v., bot., med.) nem parênteses iniciais de área. NUNCA use a própria palavra dentro da definição. TODAS as definições DEVEM respeitar o tipo gramatical da palavra (verbo→ação, substantivo→coisa, adjetivo→qualidade, etc.). Devolva APENAS JSON: {"definitions":["...","...","..."]} na MESMA ORDEM dos estilos abaixo, sem markdown.`;
    const user = `Palavra: ${word}\nDefinição verdadeira (PROIBIDO copiar, parafrasear ou usar sinônimos — a falsa deve significar OUTRA coisa): ${meaning}${categoryRule}\n\nEstilos a usar (na ordem):\n${personaInstructions}\n\nGere ${count} definições falsas convincentes, uma por estilo, TODAS coerentes com o tipo gramatical indicado e NENHUMA com o mesmo sentido da verdadeira.`;

    // Endpoint OpenAI-compatível do Google AI — mesmo formato de mensagens
    // que o gateway anterior, só muda URL/credencial/nome do modelo.
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-flash-lite-latest",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      console.error("AI gateway error", r.status, t);
      return new Response(JSON.stringify({ error: "ai_failed", definitions: [] }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await r.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    let defs: string[] = [];
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      defs = Array.isArray(parsed.definitions) ? parsed.definitions.slice(0, count) : [];
    } catch (e) {
      console.error("parse failed", e, content);
    }

    // Pós-filtro anti-vazamento (playtest 2026-07-21: sugestão da IA era a
    // própria verdade com outras palavras): descarta candidata lexicalmente
    // próxima do significado real (Dice/trigramas sobre texto normalizado).
    const normTxt = (s: string) =>
      s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const grams = (s: string): Set<string> => {
      const n = ` ${normTxt(s)} `;
      const out = new Set<string>();
      for (let i = 0; i <= n.length - 3; i++) out.add(n.slice(i, i + 3));
      return out;
    };
    const dice = (a: string, b: string): number => {
      const ga = grams(a);
      const gb = grams(b);
      if (ga.size === 0 || gb.size === 0) return 0;
      let inter = 0;
      for (const g of ga) if (gb.has(g)) inter++;
      return (2 * inter) / (ga.size + gb.size);
    };
    if (meaning) {
      const before = defs.length;
      defs = defs.filter((d) => dice(d, meaning) < 0.45);
      if (defs.length < before) {
        console.warn(
          `anti-vazamento: ${before - defs.length} candidata(s) descartada(s) por proximidade com a verdade`,
        );
      }
    }

    return new Response(JSON.stringify({ definitions: defs, personas: chosen }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bot-definitions error", e);
    return new Response(JSON.stringify({ error: String(e), definitions: [] }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});


