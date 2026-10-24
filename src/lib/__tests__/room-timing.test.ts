import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Definition, Player, Word } from "@/lib/room";

// Playtest 2026-10-20 — tempos da partida. O Supabase de mentira deixa cada
// chamada PENDENTE até o teste responder: assim dá para provar ordem e
// paralelismo (não só o resultado) e contar chamadas duplicadas.
const h = vi.hoisted(() => {
  type Call = {
    name: string;
    args: unknown;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };
  const calls: Call[] = [];
  const pend = (name: string, args?: unknown) =>
    new Promise((resolve, reject) =>
      calls.push({ name, args, resolve, reject }),
    );
  const from = (table: string) => {
    const q = {
      select: () => q,
      eq: (_col: string, value: unknown) => pend(`from:${table}`, value),
    };
    return q;
  };
  return {
    calls,
    supabase: {
      from: (table: string) => from(table),
      rpc: (name: string, args?: unknown) => pend(`rpc:${name}`, args),
      functions: {
        invoke: (name: string, opts?: unknown) => pend(`edge:${name}`, opts),
      },
    },
  };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: h.supabase }));

import {
  BOT_WRITE_MIN_MS,
  botSubmitDefinitions,
  castBotVotes,
  fetchThreeWords,
  generateAiDefinitionForPlayer,
} from "@/lib/room";
import { NUDGE_EVENT } from "@/lib/sync-nudge";
import { BOT_FAKE_DEFINITIONS_TEMPLATES } from "@/lib/bot-names";
import { wellFormedDefinition } from "@/lib/text-filter";
import { PERSONA_PROMPTS } from "../../../supabase/functions/bot-definitions-v2/prompts.ts";

const named = (name: string) => h.calls.filter((c) => c.name === name);
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const W = (id: string, word = id): Word =>
  ({ id, word, category: "x", rarity: 3 }) as Word;

beforeEach(() => {
  h.calls.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fetchThreeWords — busca paralela, mesmas regras", () => {
  it("pede as palavras da sala e o sorteio AO MESMO TEMPO (antes: em série)", async () => {
    const p = fetchThreeWords(["u1"], ["animal"], "room-1", "facil");
    await tick();
    // as duas saíram antes de qualquer resposta
    expect(named("from:room_words")).toHaveLength(1);
    expect(named("rpc:get_random_word_prompts")).toHaveLength(1);
    // mesmas regras: sem as usadas, raridade ≥ 2, categorias e nível da sala
    expect(named("rpc:get_random_word_prompts")[0]!.args).toEqual({
      exclude_ids: ["u1"],
      min_rarity: 2,
      lim: 3,
      p_categories: ["animal"],
      p_nivel: "facil",
    });
    named("from:room_words")[0]!.resolve({ data: [] });
    named("rpc:get_random_word_prompts")[0]!.resolve({
      data: [W("a"), W("b"), W("c")],
      error: null,
    });
    const words = await p;
    expect(words.map((w) => w.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("com 2 palavras da sala, completa com 1 do sorteio (e a usada não volta)", async () => {
    const p = fetchThreeWords(["c-velha"], [], "room-1");
    await tick();
    named("from:room_words")[0]!.resolve({
      data: [
        { id: "c1", word: "cafuné", category: null },
        { id: "c2", word: "xodó", category: "custom" },
        { id: "c-velha", word: "usada", category: null },
      ],
    });
    named("rpc:get_random_word_prompts")[0]!.resolve({
      data: [W("g1"), W("g2"), W("g3")],
      error: null,
    });
    const ids = (await p).map((w) => w.id).sort();
    expect(ids).toHaveLength(3);
    expect(ids).toContain("c1");
    expect(ids).toContain("c2");
    expect(ids).not.toContain("c-velha");
    expect(ids.filter((id) => id.startsWith("g"))).toHaveLength(1);
  });

  it("filtro estreito demais: cai no sorteio sem filtro, como antes", async () => {
    const p = fetchThreeWords([], ["náutica"], "room-1", "insano");
    await tick();
    named("from:room_words")[0]!.resolve({ data: [] });
    named("rpc:get_random_word_prompts")[0]!.resolve({
      data: [W("só-uma")],
      error: null,
    });
    await tick();
    const retry = named("rpc:get_random_word_prompts");
    expect(retry).toHaveLength(2);
    expect(retry[1]!.args).toEqual({
      exclude_ids: [],
      min_rarity: 2,
      lim: 3,
    });
    retry[1]!.resolve({ data: [W("x"), W("y"), W("z")] });
    expect((await p).map((w) => w.id).sort()).toEqual(["x", "y", "z"]);
  });

  it("consulta presa na rede: a segunda via sai em 1,5 s e o sorteio não espera a primeira", async () => {
    vi.useFakeTimers();
    const p = fetchThreeWords([], [], "room-1");
    await tick();
    named("rpc:get_random_word_prompts")[0]!.resolve({
      data: [W("a"), W("b"), W("c")],
      error: null,
    });
    // room_words não responde (a 1ª fica presa para sempre)
    vi.advanceTimersByTime(1500);
    await tick();
    const rw = named("from:room_words");
    expect(rw).toHaveLength(2);
    rw[1]!.resolve({ data: [] });
    expect((await p).map((w) => w.id).sort()).toEqual(["a", "b", "c"]);
  });

  // Red Team 2026-10-24: a escolha pede 9 candidatas e fica com as 3 primeiras
  // que cabem na tela (lib/word-fit.ts). Embaralhar tudo misturava o
  // complemento do servidor (get_random_words: outra categoria/nível quando o
  // filtro tem menos de 9) entre as que seguem o filtro — Direito + Fácil tem
  // 3 palavras e ~2 das 3 opções viriam de fora. Ordem de prioridade agora.
  const G = (id: string, category: string | null, nivel: string, rarity = 3) =>
    ({ id, word: id, category, nivel, rarity }) as Word;

  it("9 candidatas: as que seguem categoria + nível vêm antes do complemento, em qualquer ordem do servidor", async () => {
    const p = fetchThreeWords([], ["direito"], "room-1", "facil", 9);
    await tick();
    named("from:room_words")[0]!.resolve({ data: [] });
    named("rpc:get_random_word_prompts")[0]!.resolve({
      data: [
        G("f1", "medicina", "dificil"),
        G("d1", "direito", "facil"),
        G("f2", "direito", "dificil"), // categoria certa, nível errado
        G("f3", "planta", "facil"), // nível certo, categoria errada
        G("d2", "direito", "facil"),
        G("f4", "medicina", "medio"),
        G("f5", null, "facil"),
        G("d3", "direito", "facil"),
        G("f6", "sentimento", "facil"),
      ],
      error: null,
    });
    expect((await p).map((w) => w.id)).toEqual([
      "d1",
      "d2",
      "d3", // filtro da sala, na ordem sorteada pelo servidor
      "f1",
      "f2",
      "f3",
      "f4",
      "f5",
      "f6", // complemento: só se faltar
    ]);
  });

  it("nível aleatório com categoria: palavra comum (raridade < 2) do complemento vai para o fim", async () => {
    const p = fetchThreeWords([], ["direito"], "room-1", "aleatorio", 9);
    await tick();
    named("from:room_words")[0]!.resolve({ data: [] });
    named("rpc:get_random_word_prompts")[0]!.resolve({
      data: [
        G("comum", "direito", "facil", 1),
        G("d1", "direito", "medio"),
        G("fora", "medicina", "facil"),
        G("d2", "direito", "dificil", 2),
        ...["d3", "d4", "d5", "d6", "d7"].map((id) =>
          G(id, "direito", "medio"),
        ),
      ],
      error: null,
    });
    expect((await p).map((w) => w.id)).toEqual([
      "d1",
      "d2",
      "d3",
      "d4",
      "d5",
      "d6",
      "d7",
      "comum",
      "fora",
    ]);
  });

  it("9 candidatas: as palavras da sala vêm primeiro (com 3, sempre entravam)", async () => {
    const p = fetchThreeWords([], ["direito"], "room-1", "facil", 9);
    await tick();
    named("from:room_words")[0]!.resolve({
      data: [
        { id: "c1", word: "cafuné", category: null },
        { id: "c2", word: "xodó", category: "custom" },
      ],
    });
    named("rpc:get_random_word_prompts")[0]!.resolve({
      data: ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"].map((id) =>
        G(id, "direito", "facil"),
      ),
      error: null,
    });
    const ids = (await p).map((w) => w.id);
    expect(ids.slice(0, 2).sort()).toEqual(["c1", "c2"]);
    expect(ids.slice(2)).toEqual(["g1", "g2", "g3", "g4", "g5", "g6", "g7"]);
  });

  it("sem sala (desafio etc.): só o sorteio", async () => {
    const p = fetchThreeWords([], [], undefined);
    await tick();
    expect(named("from:room_words")).toHaveLength(0);
    named("rpc:get_random_word_prompts")[0]!.resolve({
      data: [W("a"), W("b"), W("c")],
      error: null,
    });
    expect(await p).toHaveLength(3);
  });
});

const bot = (id: string): Player =>
  ({ id, nickname: id, is_bot: true }) as Player;
const ballot: Definition[] = [
  { id: "d-t", player_id: "", letter: "A", round: 2 },
  { id: "d-b1", player_id: "b1", letter: "B", round: 2 },
  { id: "d-h", player_id: "", letter: "C", round: 2 },
] as Definition[];

// Playtest 2026-10-22: o SERVIDOR escolhe o voto dos bots (onde a verdade
// é conhecida) e só libera depois que todos os humanos votaram; o cliente
// não sorteia nem manda cédula nenhuma.
describe("castBotVotes — o servidor escolhe, o cliente só pede", () => {
  const legacy = (isHost: boolean, bots: Player[]) => ({
    isHost,
    bots,
    ballot,
  });
  const answer = async (name: string, res: unknown) => {
    await tick();
    named(name).at(-1)!.resolve(res);
    await tick();
  };

  it("pede UMA vez, só com sala, rodada e quem pede (nenhuma cédula sai do cliente)", async () => {
    const p = castBotVotes(
      "room-1",
      2,
      "p_me",
      legacy(true, [bot("b1"), bot("b2")]),
    );
    await answer("rpc:cast_bot_votes", {
      data: { ok: true, inserted: 2 },
      error: null,
    });
    expect(await p).toBe("done");
    const calls = named("rpc:cast_bot_votes");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({
      p_room_id: "room-1",
      p_round: 2,
      p_actor_id: "p_me",
    });
    expect(named("rpc:cast_votes_bulk")).toHaveLength(0);
  });

  it("sem bots: nem pede", async () => {
    expect(await castBotVotes("room-1", 2, "p_me", legacy(true, []))).toBe(
      "done",
    );
    expect(named("rpc:cast_bot_votes")).toHaveLength(0);
  });

  it("humano ainda devendo o voto no servidor: 'pending' (o cliente tenta de novo)", async () => {
    const p = castBotVotes("room-1", 2, "p_me", legacy(false, [bot("b1")]));
    await answer("rpc:cast_bot_votes", {
      data: { ok: false, reason: "humans_pending" },
      error: null,
    });
    expect(await p).toBe("pending");
  });

  it("a fase já andou (invalid_state): nada mais a votar", async () => {
    const p = castBotVotes("room-1", 2, "p_me", legacy(true, [bot("b1")]));
    await answer("rpc:cast_bot_votes", {
      data: { ok: false, reason: "invalid_state" },
      error: null,
    });
    expect(await p).toBe("done");
  });

  it("banco sem a política nova (PGRST202 ou 42883): o host cai no voto antigo, nunca na própria cédula", async () => {
    for (let i = 0; i < 24; i++) {
      const p = castBotVotes("room-1", 2, "p_me", legacy(true, [bot("b1")]));
      await answer("rpc:cast_bot_votes", {
        data: null,
        error: {
          code: i % 2 ? "42883" : "PGRST202",
          message: "function does not exist",
        },
      });
      await answer("rpc:cast_votes_bulk", { data: { ok: true }, error: null });
      expect(await p).toBe("done");
    }
    const picks = named("rpc:cast_votes_bulk").map(
      (c) =>
        (c.args as { p_votes: Array<{ definition_id: string }> }).p_votes[0]!
          .definition_id,
    );
    expect(picks).toHaveLength(24);
    expect(picks).not.toContain("d-b1");
  });

  it("banco sem a política: convidado não usa o voto antigo (é do host)", async () => {
    const p = castBotVotes("room-1", 2, "p_me", legacy(false, [bot("b1")]));
    await answer("rpc:cast_bot_votes", {
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });
    expect(await p).toBe("done");
    expect(named("rpc:cast_votes_bulk")).toHaveLength(0);
  });

  it("recusa ou outro erro do servidor vira erro, sem voto escolhido no cliente", async () => {
    const refused = castBotVotes(
      "room-1",
      2,
      "p_me",
      legacy(true, [bot("b1")]),
    );
    await answer("rpc:cast_bot_votes", {
      data: { ok: false, reason: "not_authorized" },
      error: null,
    });
    await expect(refused).rejects.toBeTruthy();
    const failed = castBotVotes("room-1", 2, "p_me", legacy(true, [bot("b1")]));
    await answer("rpc:cast_bot_votes", {
      data: null,
      error: { code: "57014", message: "canceling statement" },
    });
    await expect(failed).rejects.toBeTruthy();
    expect(named("rpc:cast_votes_bulk")).toHaveLength(0);
  });
});

describe("botSubmitDefinitions — sem pausa artificial depois da IA", () => {
  const word = { id: "w1", word: "rapapé", meaning: "bajulação" } as Word;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await vi.dynamicImportSettled();
      await tick();
    }
  };

  it("IA lenta (3 s): os bots enviam assim que ela responde", async () => {
    vi.useFakeTimers();
    void botSubmitDefinitions("room-1", 2, [bot("b1"), bot("b2")], word);
    await tick();
    expect(named("edge:bot-definitions-v2")).toHaveLength(1);
    named("rpc:get_room_definitions")[0]!.resolve({ data: [] });
    vi.advanceTimersByTime(3000);
    named("edge:bot-definitions-v2")[0]!.resolve({
      data: {
        definitions: [
          "pequeno instrumento de sopro usado em festas",
          "tecido grosso de algodao cru para sacos",
        ],
      },
    });
    await tick();
    vi.advanceTimersByTime(0);
    await settle();
    const sent = named("rpc:submit_bot_definitions_bulk");
    expect(sent).toHaveLength(1);
    expect(
      (sent[0]!.args as { p_rows: Array<{ player_id: string }> }).p_rows.map(
        (r) => r.player_id,
      ),
    ).toEqual(["b1", "b2"]);
  });

  it("mesa pronta e IA presa: no fim do prazo os bots seguem com o reserva local", async () => {
    vi.useFakeTimers();
    let hurry!: () => void;
    const prazo = new Promise<void>((r) => (hurry = r));
    void botSubmitDefinitions("room-1", 2, [bot("b1"), bot("b2")], word, {
      hurry: prazo,
    });
    await tick();
    expect(named("edge:bot-definitions-v2")).toHaveLength(1);
    named("rpc:get_room_definitions")[0]!.resolve({ data: [] }); // nunca responde
    vi.advanceTimersByTime(6000);
    hurry();
    await tick();
    vi.advanceTimersByTime(0);
    await settle();
    const sent = named("rpc:submit_bot_definitions_bulk");
    expect(sent).toHaveLength(1);
    const rows = (sent[0]!.args as { p_rows: Array<{ text: string }> }).p_rows;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.text)).size).toBe(2); // sem repetição
  });

  it("IA responde antes do prazo: os bots usam o texto da IA", async () => {
    vi.useFakeTimers();
    const prazo = new Promise<void>(() => {});
    void botSubmitDefinitions("room-1", 2, [bot("b1")], word, {
      hurry: prazo,
    });
    await tick();
    named("rpc:get_room_definitions")[0]!.resolve({ data: [] });
    vi.advanceTimersByTime(2000);
    named("edge:bot-definitions-v2")[0]!.resolve({
      data: { definitions: ["pequeno instrumento de sopro usado em festas"] },
    });
    await tick();
    vi.advanceTimersByTime(0);
    await settle();
    const rows = (
      named("rpc:submit_bot_definitions_bulk")[0]!.args as {
        p_rows: Array<{ text: string }>;
      }
    ).p_rows;
    expect(rows[0]!.text).toContain("instrumento de sopro");
  });

  it("IA rápida (0,2 s): espera só até o piso desde o início da escrita", async () => {
    vi.useFakeTimers();
    void botSubmitDefinitions("room-1", 2, [bot("b1")], word);
    await tick();
    named("rpc:get_room_definitions")[0]!.resolve({ data: [] });
    vi.advanceTimersByTime(200);
    named("edge:bot-definitions-v2")[0]!.resolve({
      data: { definitions: ["pequeno instrumento de sopro usado em festas"] },
    });
    await tick();
    vi.advanceTimersByTime(BOT_WRITE_MIN_MS - 200 - 1);
    await settle();
    expect(named("rpc:submit_bot_definitions_bulk")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await settle();
    expect(named("rpc:submit_bot_definitions_bulk")).toHaveLength(1);
  });
});

describe("aviso dos bots e sugestão do jogador (Red Team 2026-10-22)", () => {
  const word = { id: "w1", word: "rapapé", meaning: "bajulação" } as Word;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await vi.dynamicImportSettled();
      await tick();
    }
  };
  const botsSent = async () => {
    void botSubmitDefinitions("room-1", 2, [bot("b1")], word);
    await tick();
    named("rpc:get_room_definitions")[0]!.resolve({ data: [] });
    named("edge:bot-definitions-v2")[0]!.resolve({
      data: { definitions: ["pequeno instrumento de sopro usado em festas"] },
    });
    await tick();
    vi.advanceTimersByTime(BOT_WRITE_MIN_MS);
    await settle();
    const sent = named("rpc:submit_bot_definitions_bulk");
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };

  it("bots: servidor não gravou nada (0 linhas) → nenhum aviso à sala", async () => {
    vi.useFakeTimers();
    const seen = vi.fn();
    window.addEventListener(NUDGE_EVENT, seen);
    try {
      (await botsSent()).resolve({
        data: { ok: true, inserted: 0 },
        error: null,
      });
      await settle();
      expect(seen).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(NUDGE_EVENT, seen);
    }
  });

  it("bots: servidor gravou → UM aviso à sala", async () => {
    vi.useFakeTimers();
    const seen = vi.fn();
    window.addEventListener(NUDGE_EVENT, seen);
    try {
      (await botsSent()).resolve({
        data: { ok: true, inserted: 1 },
        error: null,
      });
      await settle();
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(NUDGE_EVENT, seen);
    }
  });

  it("sugestão do jogador: estilo VÁLIDO da v2 e nunca o 1º dos bots/💡", async () => {
    for (let i = 0; i < 12; i++)
      void generateAiDefinitionForPlayer(word, "room-1", 2);
    await tick();
    const ps = named("edge:bot-definitions-v2").map(
      (c) => (c.args as { body: { personas: string[] } }).body.personas[0],
    );
    expect(ps).toHaveLength(12);
    for (const p of ps) {
      expect(Object.keys(PERSONA_PROMPTS)).toContain(p);
      expect(["conciso", "contextual"]).not.toContain(p);
    }
  });

  it("IA sem candidata: usa a reserva que o SERVIDOR vetou contra a verdade", async () => {
    const p = generateAiDefinitionForPlayer(word, "room-1", 2);
    await tick();
    named("edge:bot-definitions-v2")[0]!.resolve({
      data: {
        definitions: [],
        fallbacks: ["reserva vetada pelo servidor para teste"],
      },
    });
    expect(await p).toBe("reserva vetada pelo servidor para teste");
  });

  // Forma (2026-10-24): a auto-definição nunca entrega texto quebrado.
  const quebrada = "relativo a tecido tecido com fios metalicos finos";

  it("IA mandou quebrada: pula e usa a reserva vetada — UMA chamada à edge", async () => {
    const p = generateAiDefinitionForPlayer(word, "room-1", 2);
    await tick();
    named("edge:bot-definitions-v2")[0]!.resolve({
      data: {
        definitions: [quebrada],
        fallbacks: ["reserva vetada pelo servidor para teste"],
      },
    });
    expect(await p).toBe("reserva vetada pelo servidor para teste");
    expect(named("edge:bot-definitions-v2")).toHaveLength(1);
  });

  it("tudo quebrado ou com a palavra da rodada: template local bem formado, sem máscara nem '(n)'", async () => {
    const p = generateAiDefinitionForPlayer(word, "room-1", 2);
    await tick();
    named("edge:bot-definitions-v2")[0]!.resolve({
      data: {
        definitions: [quebrada, "cerimonia de rapapes na corte antiga"],
        fallbacks: ["min mineral de coloracao escura encontrado em regioes"],
      },
    });
    const got = await p;
    const templates = BOT_FAKE_DEFINITIONS_TEMPLATES.map((t) =>
      wellFormedDefinition(t, word.word),
    );
    expect(templates).toContain(got);
    expect(got).not.toMatch(/\*|\(\d+\)|incomum/);
  });
});
