// Prompts dos bots na v2 (playtest 2026-10-20). Personas e regras de
// categoria copiadas da v1 (bot-definitions, em produção) — a v1 não é
// tocada; quando a v2 assumir em produção, a v1 sai (débito registrado).
// Sem APIs do Deno: testável no Vitest.

export const PERSONA_PROMPTS: Record<string, string> = {
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

const DEFAULT_PERSONAS = [
  "conciso",
  "analitico",
  "funcional",
  "descritivo",
  "contextual",
  "comparativo",
  "acepcao",
  "popular",
];

export const CATEGORY_RULES: Record<string, string> = {
  verbo:
    "A palavra é um VERBO. Toda definição deve descrever uma AÇÃO (comece por verbo no infinitivo: 'fazer...', 'mover...', 'cortar...'). NUNCA defina como objeto, lugar ou pessoa.",
  acao: "A palavra é uma AÇÃO. Defina como verbo no infinitivo ou frase de ação curta. NUNCA como objeto ou ser.",
  ação: "A palavra é uma AÇÃO. Defina como verbo no infinitivo ou frase de ação curta. NUNCA como objeto ou ser.",
  adjetivo:
    "A palavra é um ADJETIVO (qualidade). Defina como característica/qualidade ('que é...', 'relativo a...'). NUNCA como objeto, ação ou pessoa.",
  qualidade:
    "A palavra é uma QUALIDADE/ADJETIVO. Defina como característica ('que é...', 'aquilo que tem...'). NUNCA como objeto físico ou ação concreta.",
  substantivo:
    "A palavra é um SUBSTANTIVO. Defina como uma coisa, conceito ou ser. NUNCA comece com verbo no infinitivo descrevendo ação.",
  objeto:
    "A palavra é um OBJETO/COISA física. Defina como item, utensílio ou artefato concreto. NUNCA como ação, sentimento ou pessoa.",
  animal:
    "A palavra é um ANIMAL. Defina como bicho/ser vivo (ex.: 'pequeno mamífero...', 'ave que...'). NUNCA como objeto, planta ou ação.",
  planta:
    "A palavra é uma PLANTA. Defina como vegetal/flora (ex.: 'arbusto de...', 'planta usada para...'). NUNCA como animal, objeto ou ação.",
  lugar:
    "A palavra é um LUGAR. Defina como local geográfico ou tipo de ambiente. NUNCA como objeto portátil, animal ou ação.",
  pessoa:
    "A palavra designa uma PESSOA/profissão/tipo humano. Defina como 'aquele que...' ou 'pessoa que...'. NUNCA como objeto ou animal.",
  sentimento:
    "A palavra é um SENTIMENTO/emoção. Defina como estado emocional ou afetivo. NUNCA como objeto físico, animal ou ação concreta.",
  comportamento:
    "A palavra é um COMPORTAMENTO/atitude. Defina como modo de agir ou postura. NUNCA como objeto físico.",
  natureza:
    "A palavra pertence à NATUREZA (fenômeno, elemento natural). Defina coerentemente com isso. NUNCA como objeto fabricado.",
  gastronomia:
    "A palavra é de GASTRONOMIA (comida, prato, ingrediente). Defina como alimento/preparo. NUNCA como animal vivo, objeto não-comestível ou ação.",
  corpo:
    "A palavra se refere ao CORPO humano (parte/órgão). Defina como parte anatômica. NUNCA como objeto externo, animal ou ação.",
  ciencia:
    "A palavra é da CIÊNCIA (termo técnico, fenômeno). Defina coerentemente como conceito/fenômeno. NUNCA como objeto cotidiano banal.",
  regional:
    "A palavra é um termo REGIONAL brasileiro. Defina com sabor local mantendo o tipo gramatical correto.",
  cotidiano:
    "A palavra é do COTIDIANO. Mantenha-se coerente com o tipo provável (objeto, ação, conceito) sugerido pela palavra.",
  situação:
    "A palavra descreve uma SITUAÇÃO/circunstância. Defina como contexto ou cenário. NUNCA como objeto físico isolado.",
};

export function categoryRule(category: string): string {
  return category && CATEGORY_RULES[category]
    ? `\n\nREGRA GRAMATICAL OBRIGATÓRIA (categoria: ${category}):\n${CATEGORY_RULES[category]}`
    : "";
}

/** Uma persona por definição (rotaciona se o client não mandar). */
export function choosePersonas(count: number, fromClient: unknown): string[] {
  return Array.from({ length: count }, (_, i) => {
    const p = Array.isArray(fromClient) ? fromClient[i] : undefined;
    return typeof p === "string" && PERSONA_PROMPTS[p]
      ? p
      : DEFAULT_PERSONAS[i % DEFAULT_PERSONAS.length]!;
  });
}

/**
 * Mensagens do gerador. Mesmo núcleo da v1 + o que o playtest pediu: blefe
 * concreto e convincente, de OUTRO conceito (o juiz do 🧠 avalia depois e o
 * que chega perto da verdade é descartado), e nada do que a partida já usou.
 */
export function buildMessages(input: {
  word: string;
  meaning: string;
  category: string;
  personas: string[];
  avoid: string[];
}): Array<{ role: "system" | "user"; content: string }> {
  const n = input.personas.length;
  const personaInstructions = input.personas
    .map((p, i) => `${i + 1}. estilo "${p}": ${PERSONA_PROMPTS[p]}`)
    .join("\n");
  const system = `Você é um lexicógrafo escrevendo verbetes de dicionário para o jogo "Verbete" (Balderdash em português), jogando como uma pessoa comum e esperta da mesa. Para cada palavra rara, escreva ${n} definições FALSAS, plausíveis, em ESTILO DE DICIONÁRIO: enxutas, neutras, sem exemplos, sem "que serve para", sem rodeios. Idealmente 5 a 11 palavras, NUNCA mais que 13. Cada definição usa um ESTILO diferente (estrutura/registro variados) para parecer escrita por verbetistas distintos — VARIE as construções iniciais: evite começar todas com "que..." ou "aquele que...".

REGRA MAIS IMPORTANTE — a definição deve ser INCORRETA: se um professor de português a visse como resposta para a palavra, deveria marcá-la como ERRADA. É PROIBIDO: repetir a verdadeira, sinônimos dela, paráfrases, versões resumidas ou ampliadas, ou qualquer formulação que capture a MESMA ideia (ex.: se a verdade é "desse modo, assim sendo", então "por conseguinte" é PROIBIDO por ser sinônimo). Escolha um conceito VIZINHO mas claramente DISTINTO: outra função, outro domínio, outro objeto. Um juiz semântico vai comparar cada uma com a verdade e descartar a que chegar perto.

QUALIDADE: cada definição descreve algo CONCRETO e ESPECÍFICO, convincente para a palavra (nada vago que sirva para qualquer coisa, nada absurdo ou engraçado demais). Todas diferentes entre si.

Tudo em minúsculas, SEM acentos. NUNCA use abreviações (s.m., s.f., adj., v., bot., med.) nem parênteses iniciais de área. NUNCA use a própria palavra dentro da definição. TODAS as definições DEVEM respeitar o tipo gramatical da palavra (verbo→ação, substantivo→coisa, adjetivo→qualidade, etc.). Devolva APENAS JSON: {"definitions":["...","...","..."]} na MESMA ORDEM dos estilos abaixo, sem markdown.`;
  const avoid = input.avoid.length
    ? `\n\nJá usadas pelos bots NESTA partida — NÃO repita, NÃO reformule e não use a mesma ideia:\n${input.avoid.map((a) => `- ${a}`).join("\n")}`
    : "";
  const user = `Palavra: ${input.word}\nDefinição verdadeira (PROIBIDO copiar, parafrasear ou usar sinônimos — a falsa deve significar OUTRA coisa): ${input.meaning}${categoryRule(input.category)}${avoid}\n\nEstilos a usar (na ordem):\n${personaInstructions}\n\nGere ${n} definições falsas convincentes, uma por estilo, TODAS coerentes com o tipo gramatical indicado e NENHUMA com o mesmo sentido da verdadeira.`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
