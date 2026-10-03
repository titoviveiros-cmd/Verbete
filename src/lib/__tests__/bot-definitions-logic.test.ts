import { describe, expect, it } from "vitest";
import {
  dice,
  dropAlreadyServed,
  dropNearTruth,
  normTxt,
  outcomeEvent,
  parseDefinitions,
  servedRows,
} from "../../../supabase/functions/bot-definitions/logic.ts";
import type { ChatResult } from "../../../supabase/functions/_shared/ai.ts";
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
