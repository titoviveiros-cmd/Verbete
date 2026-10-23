import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Player, Word } from "@/lib/room";

// Playtest 2026-10-20 (2ª rodada): bots repetindo definição na partida e uma
// definição de bot que levou "🧠 Chegou perto da verdade +3". Testes A–H do
// pedido + uma partida de várias rodadas procurando repetição de verdade.
const h = vi.hoisted(() => {
  type Call = { name: string; args: unknown; resolve: (v: unknown) => void };
  const calls: Call[] = [];
  const pend = (name: string, args?: unknown) =>
    new Promise((resolve) => calls.push({ name, args, resolve }));
  return {
    calls,
    supabase: {
      rpc: (name: string, args?: unknown) => pend(`rpc:${name}`, args),
      functions: {
        invoke: (name: string, opts?: unknown) => pend(`edge:${name}`, opts),
      },
      from: () => ({ select: () => ({ eq: () => pend("from") }) }),
    },
  };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: h.supabase }));

import {
  assembleBotRows,
  BOT_MATCH_REPEAT_SIMILARITY,
  botSubmitDefinitions,
} from "@/lib/room";
import { BOT_FAKE_DEFINITIONS_TEMPLATES } from "@/lib/bot-names";
import { textSimilarity } from "@/lib/text-filter";
import {
  avoidList,
  BOT_GATE_MAX_SCORE,
  dropMatchRepeats,
  dropNearTruth,
  dropSelfSimilar,
  gateByScores,
} from "../../../supabase/functions/bot-definitions/logic.ts";
import {
  buildMessages,
  choosePersonas,
} from "../../../supabase/functions/bot-definitions-v2/prompts.ts";
import {
  pickReserves,
  RESERVE_DEFINITIONS,
} from "../../../supabase/functions/bot-definitions-v2/reserves.ts";
import {
  isSemanticMatch,
  SEMANTIC_CORE,
  SEMANTIC_THRESHOLD,
} from "../../../supabase/functions/_shared/semantic.ts";

const bot = (id: string, nickname = id): Player =>
  ({ id, nickname, avatar: "🤖", is_bot: true }) as Player;
const named = (n: string) => h.calls.filter((c) => c.name === n);
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await vi.dynamicImportSettled();
    await tick();
  }
};
const similar = (a: string, b: string) =>
  textSimilarity(a, b) > BOT_MATCH_REPEAT_SIMILARITY;

beforeEach(() => {
  h.calls.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("A — dois bots nunca recebem a mesma definição na rodada", () => {
  it("a IA repetiu o texto: o segundo bot vai para outra", () => {
    const rows = assembleBotRows({
      bots: [bot("b1"), bot("b2")],
      ai: [
        "pequeno tambor de couro usado em festas",
        "pequeno tambor de couro usado em festas",
      ],
      vetted: [],
      local: [...BOT_FAKE_DEFINITIONS_TEMPLATES],
      previous: [],
    });
    expect(rows.map((r) => r.player_id)).toEqual(["b1", "b2"]);
    expect(similar(rows[0]!.text, rows[1]!.text)).toBe(false);
  });

  it("a edge descarta candidatas parecidas entre si (fica a primeira)", () => {
    const r = dropSelfSimilar([
      "tecido grosso de algodao cru",
      "tecido grosso de algodao cru tingido",
      "danca de roda do sertao",
    ]);
    expect(r.kept).toEqual([
      "tecido grosso de algodao cru",
      "danca de roda do sertao",
    ]);
  });
});

describe("B — o que um bot disse numa rodada não volta na mesma partida", () => {
  it("edge: candidata igual/parecida com rodada anterior sai", () => {
    const previous = ["tecido grosso usado nas velas dos barcos"];
    const r = dropMatchRepeats(
      [
        "tecido grosso usado nas velas dos barcos",
        "Tecido grosso, usado nas velas de barcos!",
        "doce de abobora com cravo",
      ],
      previous,
    );
    expect(r.kept).toEqual(["doce de abobora com cravo"]);
  });

  it("client: a montagem pula o que a partida já usou (inclusive a reserva)", () => {
    const usado = BOT_FAKE_DEFINITIONS_TEMPLATES[0]!;
    const rows = assembleBotRows({
      bots: [bot("b1")],
      ai: [usado],
      vetted: [usado],
      local: [usado, ...BOT_FAKE_DEFINITIONS_TEMPLATES.slice(1)],
      previous: [usado],
    });
    expect(similar(rows[0]!.text, usado)).toBe(false);
  });

  it("o prompt da v2 leva o que a partida já usou (sem duplicar)", () => {
    const avoid = avoidList(["a ja usada um", "a ja usada um", "outra usada"]);
    expect(avoid).toEqual(["outra usada", "a ja usada um"]);
    const msgs = buildMessages({
      word: "rapape",
      meaning: "bajulacao",
      category: "comportamento",
      personas: choosePersonas(3, ["conciso"]),
      avoid,
    });
    expect(msgs[1]!.content).toContain("NESTA partida");
    expect(msgs[1]!.content).toContain("- outra usada");
    expect(msgs[1]!.content).toContain("bajulacao");
  });
});

describe("C — partida nova pode recomeçar a memória", () => {
  it("a memória é a das definições da sala, que start_game e reset_room apagam", () => {
    // Guarda: a ÚLTIMA versão das duas funções nas migrations apaga as
    // definições da sala — é isso que zera a memória numa partida nova.
    const dir = join(__dirname, "../../../supabase/migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const latest = (fn: string) => {
      let body = "";
      for (const f of files) {
        const t = readFileSync(join(dir, f), "utf8");
        const re = new RegExp(
          `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${fn}\\s*\\(`,
          "gi",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(t))) body = t.slice(m.index, m.index + 4000);
      }
      return body;
    };
    for (const fn of ["start_game", "reset_room"])
      expect(latest(fn)).toMatch(
        /DELETE FROM public\.definitions WHERE room_id = p_room_id/,
      );
  });

  it("sem memória (partida nova), um texto de partida anterior pode voltar", () => {
    const antigo = "pequeno tambor de couro usado em festas";
    const rows = assembleBotRows({
      bots: [bot("b1")],
      ai: [antigo],
      vetted: [],
      local: [...BOT_FAKE_DEFINITIONS_TEMPLATES],
      previous: [],
    });
    expect(rows[0]!.text).toBe(antigo);
  });
});

describe("D/E — bot não chega perto da verdade", () => {
  it("D: candidata com nota do juiz no corte ou acima é rejeitada", () => {
    const items = [
      { id: "c0", text: "elogio cheio de mesuras para agradar" },
      { id: "c1", text: "doce de rapadura ralada" },
    ];
    const r = gateByScores(
      items,
      new Map([
        ["c0", 86],
        ["c1", 4],
      ]),
    );
    expect(r.kept.map((k) => k.id)).toEqual(["c1"]);
  });

  it("E: lexicalmente diferente mas com o mesmo sentido — o filtro lexical deixa passar, o juiz barra", () => {
    const truth = "falta completa de dinheiro";
    const cand = "pobreza";
    expect(dropNearTruth([cand], truth).kept).toEqual([cand]); // lexical não pega
    const r = gateByScores([{ id: "c0", text: cand }], new Map([["c0", 90]]));
    expect(r.kept).toEqual([]);
  });

  it("candidata que o juiz não notou não entra (na dúvida, reserva)", () => {
    const r = gateByScores([{ id: "c0", text: "qualquer" }], new Map());
    expect(r.kept).toEqual([]);
  });

  it("o corte dos bots é mais rígido que o dos humanos e não mexe no deles", () => {
    expect(BOT_GATE_MAX_SCORE).toBeLessThan(SEMANTIC_THRESHOLD);
    expect(
      gateByScores([{ id: "x", text: "t" }], new Map([["x", 50]])).kept,
    ).toEqual([]);
    expect(
      gateByScores([{ id: "x", text: "t" }], new Map([["x", 49]])).kept,
    ).toHaveLength(1);
  });

  it("reservas vêm do SERVIDOR: a edge não aceita texto do client para o juiz (sem oráculo)", () => {
    const src = readFileSync(
      join(
        __dirname,
        "../../../supabase/functions/bot-definitions-v2/index.ts",
      ),
      "utf8",
    );
    // nada de texto lido do corpo do pedido para o juiz
    expect(src).not.toMatch(/body\??\.fallbacks/);
    expect(src).toContain("pickReserves(12)");
    expect([...RESERVE_DEFINITIONS]).toEqual([
      ...BOT_FAKE_DEFINITIONS_TEMPLATES,
    ]);
    const picked = pickReserves(12, () => 0.42);
    expect(picked).toHaveLength(12);
    expect(new Set(picked).size).toBe(12);
  });
});

describe("F/G — reserva no teto de tempo e 3 bots sem travar", () => {
  const word = { id: "w1", word: "rapape", meaning: "bajulacao" } as Word;

  it("F: IA presa e a mesa pronta — no fim do prazo, 3 bots seguem com reservas distintas", async () => {
    vi.useFakeTimers();
    let hurry!: () => void;
    const prazo = new Promise<void>((r) => (hurry = r));
    void botSubmitDefinitions(
      "room-1",
      2,
      [bot("b1"), bot("b2"), bot("b3")],
      word,
      {
        hurry: prazo,
      },
    );
    await tick();
    expect(named("edge:bot-definitions-v2")).toHaveLength(1); // nunca responde
    named("rpc:get_room_definitions")[0]!.resolve({ data: [] });
    hurry();
    await tick();
    vi.advanceTimersByTime(BOT_FLOOR);
    await settle();
    const sent = named("rpc:submit_bot_definitions_bulk");
    expect(sent).toHaveLength(1);
    const rows = (
      sent[0]!.args as { p_rows: Array<{ text: string; player_id: string }> }
    ).p_rows;
    expect(rows.map((r) => r.player_id)).toEqual(["b1", "b2", "b3"]);
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++)
        expect(similar(rows[i]!.text, rows[j]!.text)).toBe(false);
  });

  it("G: edge aprovou 1 da IA e reservas vetadas — os 3 bots entram, nada repetido", async () => {
    vi.useFakeTimers();
    void botSubmitDefinitions(
      "room-1",
      2,
      [bot("b1"), bot("b2"), bot("b3")],
      word,
    );
    await tick();
    named("rpc:get_room_definitions")[0]!.resolve({ data: [] });
    named("edge:bot-definitions-v2")[0]!.resolve({
      data: {
        definitions: ["pequeno instrumento de sopro usado em festas"],
        fallbacks: [
          "Tipo de dança popular do interior do Brasil",
          "Pequeno animal noturno de hábitos solitários",
        ],
        gate: "ok",
      },
    });
    await tick();
    vi.advanceTimersByTime(BOT_FLOOR);
    await settle();
    const rows = (
      named("rpc:submit_bot_definitions_bulk")[0]!.args as {
        p_rows: Array<{ text: string }>;
      }
    ).p_rows;
    expect(rows[0]!.text).toContain("instrumento de sopro");
    expect(rows).toHaveLength(3);
  });

  it("G: o servidor pulou um bot (texto duplicado) — ele vai de novo com outra reserva", async () => {
    vi.useFakeTimers();
    void botSubmitDefinitions(
      "room-1",
      2,
      [bot("b1"), bot("b2"), bot("b3")],
      word,
    );
    await tick();
    named("rpc:get_room_definitions")[0]!.resolve({ data: [] });
    named("edge:bot-definitions-v2")[0]!.resolve({
      data: { definitions: [], fallbacks: [] },
    });
    await tick();
    vi.advanceTimersByTime(BOT_FLOOR);
    await settle();
    named("rpc:submit_bot_definitions_bulk")[0]!.resolve({
      data: { ok: true, inserted: 2 },
    });
    await settle();
    named("rpc:get_round_sync")[0]!.resolve({
      data: {
        definitions: [
          { player_id: "b1", round: 2 },
          { player_id: "b3", round: 2 },
        ],
      },
    });
    await settle();
    const sent = named("rpc:submit_bot_definitions_bulk");
    expect(sent).toHaveLength(2);
    const first = (sent[0]!.args as { p_rows: Array<{ text: string }> }).p_rows;
    const retry = (
      sent[1]!.args as { p_rows: Array<{ player_id: string; text: string }> }
    ).p_rows;
    expect(retry.map((r) => r.player_id)).toEqual(["b2"]);
    for (const r of first) expect(similar(retry[0]!.text, r.text)).toBe(false);
  });
});

describe("partida de várias rodadas procurando repetição de verdade", () => {
  it("6 rodadas × 3 bots com uma IA que insiste nas mesmas 4 frases: nada se repete", () => {
    const iaPreguicosa = [
      "pequeno tambor de couro usado em festas",
      "tecido grosso usado nas velas dos barcos",
      "doce de abobora com cravo e canela",
      "danca de roda do interior paulista",
    ];
    const previous: string[] = [];
    for (let round = 1; round <= 6; round++) {
      // a edge v2 já tiraria as repetidas; aqui o pior caso: chega tudo
      const rows = assembleBotRows({
        bots: [bot("b1"), bot("b2"), bot("b3")],
        ai: iaPreguicosa,
        vetted: [],
        local: [...BOT_FAKE_DEFINITIONS_TEMPLATES].sort(
          () => 0.5 - ((round * 7) % 10) / 10,
        ),
        previous,
      });
      previous.push(...rows.map((r) => r.text));
    }
    expect(previous).toHaveLength(18);
    for (let i = 0; i < previous.length; i++)
      for (let j = i + 1; j < previous.length; j++)
        expect(
          similar(previous[i]!, previous[j]!),
          `"${previous[i]}" × "${previous[j]}"`,
        ).toBe(false);
  });
});

describe("H — pontuação humana igual", () => {
  it("limiar 80 e regra de acerto intocados", () => {
    expect(SEMANTIC_THRESHOLD).toBe(80);
    expect(isSemanticMatch(80)).toBe(true);
    expect(isSemanticMatch(79)).toBe(false);
  });
  it("o prompt do juiz (rubrica, regras, exemplos) é byte a byte o mesmo", () => {
    const sha = createHash("sha256").update(SEMANTIC_CORE).digest("hex");
    expect(sha).toBe(SEMANTIC_CORE_SHA256);
  });
});

const BOT_FLOOR = 1500;
// sha256 do SEMANTIC_CORE no commit de base desta rodada (f883f1d).
const SEMANTIC_CORE_SHA256 =
  "c18d7d7d7c643b8d2e7925b2494c36f212678b9aec49e3380943370980ddfc17";
