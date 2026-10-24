import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  definitionShapeIssue,
  dice,
  dropAlreadyServed,
  dropMalformed,
  dropNearTruth,
  gatherCandidates,
  normTxt,
  outcomeEvent,
  parseDefinitions,
  regenEventFields,
  REGEN_EXTRA,
  REGEN_MAX_ELAPSED_MS,
  REGEN_TIMEOUT_MS,
  servedRows,
  SHAPE_RULES,
  SHAPE_VOCAB,
  type GenerateRequest,
} from "../../../supabase/functions/bot-definitions/logic.ts";
import type { ChatResult } from "../../../supabase/functions/_shared/ai.ts";
import { RESERVE_DEFINITIONS } from "../../../supabase/functions/bot-definitions-v2/reserves.ts";
import * as client from "../text-filter";
import { sanitizeDefinition } from "../text-filter";

const okChat: ChatResult = { ok: true, content: "", attempts: 1 };

describe("normTxt / dice", () => {
  it("normaliza acento, caixa e pontuação", () => {
    expect(normTxt("  Árvore-de NATAL!! ")).toBe("arvore de natal");
  });
  it("dice é 1 para textos iguais após normalizar e baixo para textos distintos", () => {
    expect(dice("Pão de queijo", "pao de QUEIJO")).toBe(1);
    expect(
      dice("ave de rapina noturna", "ferramenta de carpintaria"),
    ).toBeLessThan(0.2);
  });
});

describe("parseDefinitions", () => {
  it("extrai as definições na ordem, respeitando o limite pedido", () => {
    expect(
      parseDefinitions('{"definitions":["a b c","d e f","g h i"]}', 2),
    ).toEqual(["a b c", "d e f"]);
  });
  it("descarta itens que não são texto ou estão vazios", () => {
    expect(
      parseDefinitions('{"definitions":["ok", 3, null, "  "]}', 5),
    ).toEqual(["ok"]);
  });
  it("resposta sem o campo, ou não-JSON, é null (vira erro, não fallback silencioso)", () => {
    expect(parseDefinitions('{"defs":["x"]}', 3)).toBeNull();
    expect(parseDefinitions("desculpe, não posso ajudar", 3)).toBeNull();
  });
  it("lista vazia é válida (vira fallback)", () => {
    expect(parseDefinitions('{"definitions":[]}', 3)).toEqual([]);
  });
});

describe("dropNearTruth (anti-vazamento da verdade)", () => {
  const meaning = "pequeno pássaro canoro de plumagem amarela";
  it("descarta candidata que parafraseia a verdade e mantém as distintas", () => {
    const r = dropNearTruth(
      [
        "pequeno passaro canoro de plumagem amarela e verde",
        "utensílio de cozinha para coar café",
      ],
      meaning,
    );
    expect(r.kept).toEqual(["utensílio de cozinha para coar café"]);
    expect(r.dropped).toBe(1);
  });
  it("sem significado conhecido, não filtra", () => {
    expect(dropNearTruth(["x y z"], "")).toEqual({
      kept: ["x y z"],
      dropped: 0,
    });
  });
});

describe("dropAlreadyServed (memória por rodada — o caminho do bug norm/normTxt)", () => {
  it("roda sem exceção e remove repetições exatas e quase-repetições", () => {
    const served = [normTxt("Ferramenta usada para entalhar madeira")];
    const r = dropAlreadyServed(
      [
        "ferramenta usada para entalhar madeira",
        "Ferramenta usada para entalhar madeiras",
        "doce típico feito de mandioca ralada",
      ],
      served,
    );
    expect(r.kept).toEqual(["doce típico feito de mandioca ralada"]);
    expect(r.dropped).toBe(2);
  });
  it("sem nada servido ainda, mantém tudo", () => {
    expect(dropAlreadyServed(["a b c"], [])).toEqual({
      kept: ["a b c"],
      dropped: 0,
    });
  });
  it("as linhas gravadas na memória usam o texto normalizado", () => {
    expect(servedRows(["Árvore Velha!"], "room-1", 3)).toEqual([
      { room_id: "room-1", round: 3, norm_text: "arvore velha" },
    ]);
  });
});

describe("pipeline completo da edge (modelo → filtros → evento)", () => {
  it("filtra vazamento e repetição, serve o resto e registra sucesso sem texto", () => {
    const content =
      '```json\n{"definitions":["pequeno passaro canoro amarelo","peca de ferro do arado","danca popular do sertao"]}\n```';
    const parsed = parseDefinitions(content, 3);
    expect(parsed).not.toBeNull();
    const leak = dropNearTruth(parsed ?? [], "pequeno pássaro canoro amarelo");
    const fresh = dropAlreadyServed(leak.kept, [
      normTxt("Peça de ferro do arado"),
    ]);
    expect(fresh.kept).toEqual(["danca popular do sertao"]);

    const ev = outcomeEvent({
      chat: okChat,
      parsedCount: parsed?.length ?? null,
      requested: 3,
      returned: fresh.kept.length,
      droppedLeak: leak.dropped,
      droppedServed: fresh.dropped,
      latencyMs: 900,
    });
    expect(ev.kind).toBe("bot_ai_success");
    expect(ev.payload).toMatchObject({
      returned: 1,
      dropped_leak: 1,
      dropped_served: 1,
    });
    const flat = JSON.stringify(ev.payload);
    expect(flat).not.toMatch(/passaro|arado|sertao/);
  });

  it("tudo filtrado → fallback (o client usa templates), com o motivo", () => {
    const ev = outcomeEvent({
      chat: okChat,
      parsedCount: 2,
      requested: 2,
      returned: 0,
      droppedLeak: 2,
      droppedServed: 0,
      latencyMs: 10,
    });
    expect(ev).toMatchObject({
      kind: "bot_ai_fallback",
      payload: { reason: "all_filtered" },
    });
  });

  it("modelo respondeu lista vazia → fallback 'empty'", () => {
    const ev = outcomeEvent({
      chat: okChat,
      parsedCount: 0,
      requested: 2,
      returned: 0,
      droppedLeak: 0,
      droppedServed: 0,
      latencyMs: 10,
    });
    expect(ev).toMatchObject({
      kind: "bot_ai_fallback",
      payload: { reason: "empty" },
    });
  });

  it("erro do Gemini (429/timeout) e resposta inválida viram bot_ai_error", () => {
    const e429 = outcomeEvent({
      chat: { ok: false, reason: "http_error", status: 429, attempts: 2 },
      parsedCount: null,
      requested: 3,
      returned: 0,
      droppedLeak: 0,
      droppedServed: 0,
      latencyMs: 9000,
    });
    expect(e429).toMatchObject({
      kind: "bot_ai_error",
      payload: { reason: "http_error", status: 429, attempts: 2 },
    });
    const eTimeout = outcomeEvent({
      chat: { ok: false, reason: "timeout", attempts: 2 },
      parsedCount: null,
      requested: 3,
      returned: 0,
      droppedLeak: 0,
      droppedServed: 0,
      latencyMs: 16000,
    });
    expect(eTimeout).toMatchObject({
      kind: "bot_ai_error",
      payload: { reason: "timeout" },
    });
    const eInvalid = outcomeEvent({
      chat: okChat,
      parsedCount: null,
      requested: 3,
      returned: 0,
      droppedLeak: 0,
      droppedServed: 0,
      latencyMs: 10,
    });
    expect(eInvalid).toMatchObject({
      kind: "bot_ai_error",
      payload: { reason: "invalid_response" },
    });
  });

  it("conteúdo inadequado vindo da IA é mascarado antes de virar cédula", () => {
    const fromModel =
      "lugar onde se fala merda o dia todo https://spam.example";
    const ballot = sanitizeDefinition(fromModel, 140, "palavra");
    expect(ballot).not.toMatch(/merda/);
    expect(ballot).not.toMatch(/https?:/);
  });
});

// ---------------------------------------------------------------------------
// FORMA (2026-10-24): o modelo "gaguejou" em 3 de 908 textos servidos.
const REAL_BROKEN = [
  "min mineral de coloracao escura encontrado em regioes montanhosas",
  "relativo a tecido tecido com fios metalicos finos",
  "em horticultura trepadeira trepadeira de frutos comestiveis",
];
const MUST_PASS = [
  "pessoa que costuma mentir, mentiroso contumaz",
  "ato de vangloriar-se em publico",
  "ato de vangloriar-se",
  "instrumento de percussao semelhante ao reco-reco",
  "ferramenta curva usada na poda de videiras",
  "tecido grosso de algodao cru para sacos",
  "doce de abobora com cravo e canela",
  "pequena fonte semelhante a um olho-d'agua",
  "tipo de penteado popular nos anos 70",
  "em culinaria, molho espesso feito com farinha torrada",
  "massa de barro usada para parede de taipa",
  "relativo a pessoa que fala demais (e alto)",
  "Árvore de copa larga típica do cerrado",
];

describe("forma — definitionShapeIssue (R1–R7) no texto cru do modelo", () => {
  it("os 3 casos reais de produção são rejeitados (gagueira)", () => {
    for (const t of REAL_BROKEN)
      expect(definitionShapeIssue(t), t).toBe("stutter");
  });

  it("negativos que DEVEM passar: pontuação, hífen e definições normais", () => {
    for (const t of MUST_PASS) expect(definitionShapeIssue(t), t).toBeNull();
  });

  it("todas as reservas existentes passam (com e sem palavra da rodada)", () => {
    for (const t of RESERVE_DEFINITIONS) {
      expect(definitionShapeIssue(t), t).toBeNull();
      expect(definitionShapeIssue(t, "rapapé"), t).toBeNull();
    }
  });

  it.each([
    ["length", "pequeno animal"],
    ["length", "de do da"],
    ["length", "palavra ".repeat(17)],
    ["length", `objeto ${"muito ".repeat(19)}antigo de madeira`],
    ["stutter", "pedaco de uma uma carne assada"],
    ["label", "(bot.) planta rasteira de folhas largas"],
    ["label", "s.m. instrumento antigo de sopro"],
    ["label", "adj. relativo a pessoas teimosas"],
    ["label", "bot planta rasteira de folhas largas"],
    ["truncated", "ferramenta usada para cortar o"],
    ["truncated", "doce feito com leite condensado e"],
    ["truncated", "objeto de metal usado em festas,"],
    ["truncated", "tipo de tecido grosso (usado em velas"],
    ["truncated", "planta rasteira de folhas largas -"],
    ["junk", "danca tipica do interior do brasil (3)"],
    ["junk", 'tecido "grosso" usado em velas'],
    ["junk", "pequeno objeto de metal.. usado em festas"],
    ["junk", "tipo de doce feito com mel…"],
    ["junk", "planta usada em chas_calmantes caseiros"],
    ["chars", "doce tipico feito com mel 🍯 e canela"],
    ["chars", "planta rasteira de folhas largas!"],
    ["chars", "pequeno objeto brrr de metal antigo"],
    ["chars", "vaso em forma de u usado na cozinha"],
    ["chars", "ave de canto agudo – muito comum"],
  ])("%s: %s", (rule, text) => {
    expect(definitionShapeIssue(text)).toBe(rule);
  });

  it("R7: a palavra da rodada (ou a raiz) no texto é rejeitada, não mascarada", () => {
    expect(
      definitionShapeIssue("cerimonia de rapapes na corte", "rapapé"),
    ).toBe("word");
    expect(
      definitionShapeIssue("danca de roda r-a-p-a-p-e no interior", "rapapé"),
    ).toBe("word");
    expect(
      definitionShapeIssue("cerimonia de mesuras na corte", "rapapé"),
    ).toBeNull();
    // palavra curta demais para o anti-cola: igual ao leaksWord do client
    expect(
      definitionShapeIssue("tecido de ab usado em velas", "ab"),
    ).toBeNull();
  });

  it("dropMalformed: mantém a ordem e conta por regra", () => {
    const r = dropMalformed(
      [REAL_BROKEN[1]!, "doce de abobora com cravo", "ferramenta usada para o"],
      "rapapé",
    );
    expect(r.kept).toEqual(["doce de abobora com cravo"]);
    expect(r.dropped).toBe(2);
    expect(r.byRule).toEqual({ stutter: 1, truncated: 1 });
  });
});

describe("forma — cópia do client (text-filter) responde igual à do servidor", () => {
  it("mesmas regras, na mesma ordem, e mesmas listas", () => {
    expect([...client.SHAPE_RULES]).toEqual([...SHAPE_RULES]);
    expect(client.SHAPE_VOCAB).toEqual(SHAPE_VOCAB);
  });

  it("mesmo veredito em reservas, casos reais, negativos e 3.000 textos sorteados", () => {
    const pieces = [
      "tecido",
      "tecido,",
      "min",
      "mineral",
      "s.m.",
      "(bot.)",
      "adj.",
      "Bras.",
      "reco-reco",
      "mentir,",
      "mentiroso",
      "de",
      "da",
      "que",
      "cujo",
      "a",
      "o",
      "x",
      "u",
      "km",
      "70",
      "(3)",
      "..",
      "…",
      "pé-de-moleque",
      "olho-d'água",
      "ÁGUA",
      "Árvore",
      "ção",
      "café",
      "com",
      "comida",
      "-",
      "(",
      ")",
      "rapapé",
      "rapapés",
      "r.a.p.a.p.e",
      '"aspas"',
      "{x}",
      "_",
      "#",
      "|",
      "brrr",
      "y",
      "e/ou",
      "–",
      "!",
      "🍯",
      "ﬁ",
      "ñ",
      "doce",
      "festa",
      "pequeno",
      "usado",
      "em",
      "para",
      "parede",
      "uma",
      "uma",
      "trepadeira",
      "canela,",
      "sombrio",
    ];
    let seed = 20261024;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const fuzz = Array.from({ length: 3000 }, () => {
      const n = 1 + Math.floor(rnd() * 16);
      const sep = rnd() < 0.1 ? "  " : " ";
      return Array.from(
        { length: n },
        () => pieces[Math.floor(rnd() * pieces.length)]!,
      ).join(sep);
    });
    const corpus = [
      ...RESERVE_DEFINITIONS,
      ...REAL_BROKEN,
      ...MUST_PASS,
      ...fuzz,
    ];
    const seen = new Set<string | null>();
    for (const word of ["", "rapapé", "tecido", "pé-de-moleque", "ab"])
      for (const t of corpus) {
        const server = definitionShapeIssue(t, word);
        seen.add(server);
        expect(client.definitionShapeIssue(t, word), `${word} | ${t}`).toBe(
          server,
        );
      }
    // o sorteio exercita TODAS as regras (e o caso bem formado)
    expect([...seen].sort()).toEqual([...SHAPE_RULES, null].sort());
  });
});

// Pipeline da v2 com relógio e modelo injetados (logic.ts/gatherCandidates).
const GOOD = [
  "tecido grosso de algodao cru para sacos",
  "danca de roda tipica do litoral",
  "utensilio de ferro usado para moer graos",
  "doce de abobora com cravo e canela",
  "pequeno tambor de couro usado em festas",
  "ave de canto agudo que vive nos brejos",
  "ferramenta curva usada na poda de videiras",
];
const BROKEN = [
  ...REAL_BROKEN,
  "ferramenta usada para cortar o",
  "danca tipica do interior do brasil (3)",
];
const answer = (defs: string[]): ChatResult => ({
  ok: true,
  content: JSON.stringify({ definitions: defs }),
  attempts: 1,
});
const PERSONAS = [
  "conciso",
  "analitico",
  "funcional",
  "descritivo",
  "contextual",
  "comparativo",
];

function harness(opts: {
  responses: Array<{ chat: ChatResult; ms: number }>;
  count?: number;
  /** ms gastos antes da 1ª chamada (leituras do banco) */
  before?: number;
  totalBudgetMs?: number;
  meaning?: string;
}) {
  const t0 = 50_000;
  let clock = t0 + (opts.before ?? 300);
  const calls: GenerateRequest[] = [];
  const generate = vi.fn(async (req: GenerateRequest) => {
    calls.push(req);
    const r = opts.responses[calls.length - 1];
    if (!r) throw new Error("chamada ao modelo além do previsto");
    clock += r.ms;
    return r.chat;
  });
  const run = () =>
    gatherCandidates({
      count: opts.count ?? 3,
      word: "rapapé",
      meaning: opts.meaning ?? "bajulacao exagerada",
      previous: ["moeda de pouco valor usada em trocas rurais"],
      servedNorms: [],
      personas: PERSONAS,
      morePersonas: (n) => Array.from({ length: n }, (_, i) => `extra${i}`),
      genTimeoutMs: 6000,
      totalBudgetMs: opts.totalBudgetMs ?? 9500,
      t0,
      now: () => clock,
      generate,
    });
  return { run, calls, generate };
}

describe("pipeline v2 — forma antes dos filtros, sem texto no evento", () => {
  it("1 candidata quebrada: sai, a próxima válida entra, dropped_shape 1 e evento sem texto", async () => {
    const h = harness({
      responses: [
        { chat: answer([REAL_BROKEN[1]!, ...GOOD.slice(0, 5)]), ms: 1200 },
      ],
    });
    const gen = await h.run();
    expect(h.generate).toHaveBeenCalledTimes(1); // sobrou o bastante: sem regeneração
    expect(gen.candidates).toEqual(GOOD.slice(0, 5));
    expect(gen.dropped.shape).toEqual({ stutter: 1 });
    const ev = outcomeEvent({
      chat: gen.chat,
      parsedCount: gen.parsedCount,
      requested: 3,
      returned: 3,
      droppedLeak: gen.dropped.leak,
      droppedServed: gen.dropped.served,
      droppedShape: gen.dropped.shape,
      latencyMs: 2000,
    });
    const payload = { ...ev.payload, ...regenEventFields(gen.regen) };
    expect(ev.kind).toBe("bot_ai_success");
    expect(payload).toMatchObject({
      dropped_shape: 1,
      shape_stutter: 1,
      regen: 0,
    });
    expect(JSON.stringify(payload)).not.toMatch(/tecido|metalicos|algodao/);
  });

  it("a forma vem ANTES do anti-vazamento: quebrada e perto da verdade conta como forma", async () => {
    const h = harness({
      meaning: "relativo a tecido com fios metalicos finos",
      responses: [
        { chat: answer([REAL_BROKEN[1]!, ...GOOD.slice(0, 5)]), ms: 900 },
      ],
    });
    const gen = await h.run();
    expect(gen.dropped.shape).toEqual({ stutter: 1 });
    expect(gen.dropped.leak).toBe(0);
  });

  it("tudo quebrado e nenhuma resposta aproveitável: fallback all_filtered com as contagens", () => {
    const ev = outcomeEvent({
      chat: answer([]),
      parsedCount: 4,
      requested: 2,
      returned: 0,
      droppedLeak: 0,
      droppedServed: 0,
      droppedShape: { stutter: 3, truncated: 1 },
      latencyMs: 10,
    });
    expect(ev).toMatchObject({
      kind: "bot_ai_fallback",
      payload: {
        reason: "all_filtered",
        dropped_shape: 4,
        shape_stutter: 3,
        shape_truncated: 1,
      },
    });
  });
});

describe("pipeline v2 — no máximo UMA regeneração, antes do juiz e dentro do prazo", () => {
  it("faltou candidata: pede só o que falta +2, curta, sem nova tentativa, evitando o que já viu", async () => {
    const h = harness({
      before: 300,
      responses: [
        { chat: answer([...BROKEN.slice(0, 4), GOOD[0]!, GOOD[1]!]), ms: 1500 },
        { chat: answer([GOOD[2]!, GOOD[3]!, GOOD[4]!]), ms: 800 },
      ],
    });
    const gen = await h.run();
    expect(h.generate).toHaveBeenCalledTimes(2);
    const [first, regen] = h.calls;
    expect(first).toMatchObject({ timeoutMs: 6000, retries: 0 });
    expect(regen!.personas).toHaveLength(3 - 2 + REGEN_EXTRA);
    expect(regen!.timeoutMs).toBe(REGEN_TIMEOUT_MS);
    expect(regen!.retries).toBe(0);
    for (const seen of [...BROKEN.slice(0, 4), GOOD[0]!, GOOD[1]!])
      expect(regen!.avoid).toContain(seen);
    expect(regen!.avoid).toContain(
      "moeda de pouco valor usada em trocas rurais",
    );
    expect(gen.candidates).toEqual(GOOD.slice(0, 5));
    expect(gen.regen).toEqual({ calls: 1, ms: 800, added: 3 });
    expect(gen.chat).toMatchObject({ ok: true, attempts: 2 });
    expect(regenEventFields(gen.regen)).toEqual({
      regen: 1,
      regen_ms: 800,
      regen_added: 3,
    });
  });

  it("a regeneração também veio quebrada: nenhuma 3ª chamada, saem MENOS definições", async () => {
    const h = harness({
      responses: [
        { chat: answer([...BROKEN, REAL_BROKEN[0]!]), ms: 1000 },
        { chat: answer([...BROKEN]), ms: 1000 },
      ],
    });
    const gen = await h.run();
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(gen.candidates).toEqual([]);
    expect(gen.regen).toMatchObject({ calls: 1, added: 0 });
    const ev = outcomeEvent({
      chat: gen.chat,
      parsedCount: gen.parsedCount,
      requested: 3,
      returned: 0,
      droppedLeak: gen.dropped.leak,
      droppedServed: gen.dropped.served,
      droppedShape: gen.dropped.shape,
      latencyMs: 2300,
    });
    expect(ev).toMatchObject({
      kind: "bot_ai_fallback",
      payload: { reason: "all_filtered", dropped_shape: 11 },
    });
  });

  it("prazo: a 1ª leva acabou depois de 4000 ms → não regenera; em 4000 ms ainda regenera", async () => {
    const late = harness({
      before: 300,
      responses: [
        {
          chat: answer([BROKEN[0]!, GOOD[0]!]),
          ms: REGEN_MAX_ELAPSED_MS - 300 + 1,
        },
      ],
    });
    const g1 = await late.run();
    expect(late.generate).toHaveBeenCalledTimes(1);
    expect(g1.regen).toMatchObject({ calls: 0, skipped: "time" });
    expect(regenEventFields(g1.regen)).toEqual({
      regen: 0,
      regen_skip: "time",
    });

    const edge = harness({
      before: 0,
      responses: [
        { chat: answer([BROKEN[0]!, GOOD[0]!]), ms: REGEN_MAX_ELAPSED_MS },
        { chat: answer([GOOD[1]!, GOOD[2]!]), ms: 500 },
      ],
    });
    const g2 = await edge.run();
    expect(edge.generate).toHaveBeenCalledTimes(2);
    expect(g2.candidates).toEqual(GOOD.slice(0, 3));
  });

  it("o tempo da regeneração é min(3000, orçamento − decorrido − 2000); sem folga, não regenera", async () => {
    const tight = harness({
      before: 0,
      totalBudgetMs: 7000,
      responses: [
        { chat: answer([GOOD[0]!]), ms: 3900 },
        { chat: answer([GOOD[1]!, GOOD[2]!]), ms: 1000 },
      ],
    });
    await tight.run();
    expect(tight.calls[1]!.timeoutMs).toBe(7000 - 3900 - 2000);

    const none = harness({
      before: 0,
      totalBudgetMs: 5500,
      responses: [{ chat: answer([GOOD[0]!]), ms: 3600 }],
    });
    const g = await none.run();
    expect(none.generate).toHaveBeenCalledTimes(1);
    expect(g.regen.skipped).toBe("time");
  });

  it.each([
    ["503", { ok: false, reason: "http_error", status: 503, attempts: 1 }],
    ["timeout", { ok: false, reason: "timeout", attempts: 1 }],
    ["429", { ok: false, reason: "http_error", status: 429, attempts: 1 }],
    ["504", { ok: false, reason: "http_error", status: 504, attempts: 1 }],
  ] as Array<[string, ChatResult]>)(
    "1ª chamada com %s: não regenera (modelo sobrecarregado) e o evento é erro",
    async (_name, chat) => {
      const h = harness({ responses: [{ chat, ms: 900 }] });
      const gen = await h.run();
      expect(h.generate).toHaveBeenCalledTimes(1);
      expect(gen.regen).toMatchObject({ calls: 0, skipped: "overload" });
      expect(gen.candidates).toEqual([]);
      expect(
        outcomeEvent({
          chat: gen.chat,
          parsedCount: gen.parsedCount,
          requested: 3,
          returned: 0,
          droppedLeak: 0,
          droppedServed: 0,
          latencyMs: 900,
        }).kind,
      ).toBe("bot_ai_error");
    },
  );

  it("erro de rede na 1ª, ainda cedo: UMA regeneração; a resposta dela vale para o evento", async () => {
    const h = harness({
      responses: [
        { chat: { ok: false, reason: "network", attempts: 1 }, ms: 200 },
        { chat: answer(GOOD.slice(0, 5)), ms: 1000 },
      ],
    });
    const gen = await h.run();
    expect(h.calls[1]!.personas).toHaveLength(3 + REGEN_EXTRA);
    expect(gen.candidates).toEqual(GOOD.slice(0, 5));
    expect(gen.chat).toMatchObject({ ok: true, attempts: 2 });
    expect(gen.parsedCount).toBe(5);
  });

  it("regeneração que falha fica registrada pelo motivo, sem texto", async () => {
    const h = harness({
      responses: [
        { chat: answer([BROKEN[1]!, GOOD[0]!]), ms: 700 },
        { chat: { ok: false, reason: "timeout", attempts: 1 }, ms: 3000 },
      ],
    });
    const gen = await h.run();
    expect(gen.candidates).toEqual([GOOD[0]]);
    expect(gen.chat).toMatchObject({ ok: true, attempts: 2 });
    expect(regenEventFields(gen.regen)).toEqual({
      regen: 1,
      regen_ms: 3000,
      regen_added: 0,
      regen_fail: "timeout",
    });
  });
});

describe("edges: onde a forma foi plugada", () => {
  const src = (fn: string) =>
    readFileSync(
      join(__dirname, `../../../supabase/functions/${fn}/index.ts`),
      "utf8",
    );
  const count = (s: string, needle: string) => s.split(needle).length - 1;

  it("v2: forma+filtros+regeneração antes de UM juiz; memória só com o aprovado; reservas também passam pela forma", () => {
    const s = src("bot-definitions-v2");
    expect(count(s, "gatherCandidates(")).toBe(1);
    expect(count(s, "judgeCandidates(")).toBe(1);
    expect(count(s, "callChat(")).toBe(1); // o gerador injetado
    const gather = s.indexOf("gatherCandidates(");
    const judge = s.indexOf("judgeCandidates(");
    const upsert = s.indexOf("servedRows(definitions");
    expect(gather).toBeGreaterThan(0);
    expect(gather).toBeLessThan(judge);
    expect(judge).toBeLessThan(upsert);
    expect(s).toContain("dropMalformed(fallbacksIn, word)");
    expect(s).toContain("droppedShape: gen.dropped.shape");
    expect(s).toContain("...regenEventFields(gen.regen)");
  });

  it("v1 (sugestões): forma logo depois do parse, antes do anti-vazamento e da memória", () => {
    const s = src("bot-definitions");
    const shape = s.indexOf("dropMalformed(parsed ?? [], word)");
    expect(shape).toBeGreaterThan(0);
    expect(s.indexOf("dropNearTruth(shape.kept, meaning)")).toBeGreaterThan(
      shape,
    );
    expect(s.indexOf("servedRows(defs")).toBeGreaterThan(shape);
    expect(s).toContain("droppedShape: shape.byRule");
  });
});
