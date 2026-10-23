import { afterEach, describe, expect, it, vi } from "vitest";
import { fileReport, ReportInput } from "@/lib/report-definition";

// Denúncia durante a votação (RC Android 2.1.0, teste real das 4 ações): a
// cédula chega SEM autor (player_id "") e o servidor recusava toda denúncia
// ("offenderPlayerId: String must contain at least 1 character(s)"). Agora o
// servidor acha autor, texto e sala no banco pelo id da cédula — e (Red Team,
// P0) a cédula verdadeira passa pelo MESMO caminho: mesma resposta, mesmas
// consultas, mesma gravação (só que já descartada).

type Row = Record<string, unknown>;
type Fail = Partial<Record<string, unknown>>; // "tabela.op" → erro
/** Banco falso: from().select().eq()…maybeSingle()/limit() e insert(). */
function fakeDb(tables: Record<string, Row[]>, fail: Fail = {}) {
  const inserted: Row[] = [];
  const ops: string[] = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const rows = () =>
      (tables[table] ?? []).filter((r) =>
        filters.every(([c, v]) => r[c] === v),
      );
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => (filters.push([col, val]), q),
      maybeSingle: async () => {
        ops.push(`${table}.select`);
        // como o PostgREST: mais de uma linha → erro PGRST116, data nulo
        const many = rows().length > 1 ? { code: "PGRST116" } : null;
        const error = fail[`${table}.select`] ?? many;
        return { data: error ? null : (rows()[0] ?? null), error };
      },
      limit: async (n: number) => {
        ops.push(`${table}.select`);
        const error = fail[`${table}.select`] ?? null;
        return { data: error ? null : rows().slice(0, n), error };
      },
      insert: async (row: Row) => {
        ops.push(`${table}.insert`);
        const error = fail[`${table}.insert`] ?? null;
        if (!error) inserted.push({ table, ...row });
        return { error };
      },
    };
    return q;
  };
  return { db: { from } as never, inserted, ops };
}

const ROOM = "11111111-1111-4111-8111-111111111111";
const BOT_DEF = "22222222-2222-4222-8222-222222222222";
const TRUTH_DEF = "33333333-3333-4333-8333-333333333333";
const HUMAN_DEF = "44444444-4444-4444-8444-444444444444";
const tables = () => ({
  rooms: [{ id: ROOM, code: "4321" }],
  definitions: [
    {
      id: BOT_DEF,
      room_id: ROOM,
      round: 2,
      player_id: "bot-1",
      text: "texto do banco",
      is_truth: false,
    },
    {
      id: TRUTH_DEF,
      room_id: ROOM,
      round: 2,
      player_id: "__truth__",
      text: "a verdadeira",
      is_truth: true,
    },
    {
      id: HUMAN_DEF,
      room_id: ROOM,
      round: 2,
      player_id: "p-ana",
      text: "da Ana",
      is_truth: false,
    },
  ],
  players: [
    { id: "bot-1", room_id: ROOM, nickname: "Robô", user_id: null },
    { id: "p-ana", room_id: ROOM, nickname: "Ana", user_id: "user-ana" },
  ],
  reports: [] as Row[],
});

/** Exatamente o que o cliente ANTIGO mandava de uma cédula da votação. */
const votingPayload = (definitionId: string) => ({
  definitionId,
  definitionText: "texto forjado pelo cliente",
  roomId: ROOM,
  roomCode: "9999",
  round: 2,
  offenderPlayerId: "",
  offenderNickname: null,
  reason: "spam",
});
const report = (db: never, id: string, who = "r") =>
  fileReport(db, who, ReportInput.parse(votingPayload(id)));

afterEach(() => vi.restoreAllMocks());

describe("denúncia de definição", () => {
  it("cédula da votação (autor oculto) é aceita — o servidor recusava", () => {
    expect(ReportInput.parse(votingPayload(BOT_DEF))).toEqual({
      definitionId: BOT_DEF,
      reason: "spam",
    });
  });

  it("autor, texto e sala vêm do BANCO — nada do que o cliente afirma", async () => {
    const { db, inserted } = fakeDb(tables());
    await expect(report(db, HUMAN_DEF, "reporter-1")).resolves.toEqual({
      ok: true,
    });
    expect(inserted).toEqual([
      {
        table: "reports",
        definition_id: HUMAN_DEF,
        definition_text: "da Ana",
        room_id: ROOM,
        room_code: "4321",
        round: 2,
        offender_player_id: "p-ana",
        offender_nickname: "Ana",
        offender_user_id: "user-ana",
        reporter_user_id: "reporter-1",
        reason: "spam",
      },
    ]);
  });

  it("verdadeira: MESMA resposta, MESMAS consultas e gravação — já descartada", async () => {
    const real = fakeDb(tables());
    const truth = fakeDb(tables());
    const a = await report(real.db, BOT_DEF);
    const b = await report(truth.db, TRUTH_DEF);
    expect(b).toEqual(a);
    expect(truth.ops).toEqual(real.ops);
    expect(real.ops).toEqual([
      "definitions.select",
      "reports.select",
      "rooms.select",
      "players.select",
      "reports.insert",
    ]);
    expect(real.inserted[0]).not.toHaveProperty("status"); // pending (padrão)
    expect(truth.inserted[0]).toMatchObject({
      definition_id: TRUTH_DEF,
      status: "dismissed",
    });
  });

  it("marca de verdadeira por qualquer um dos dois campos", async () => {
    for (const patch of [
      { is_truth: true, player_id: "bot-1" },
      { is_truth: false, player_id: "__truth__" },
    ]) {
      const t = tables();
      Object.assign(t.definitions[0]!, patch);
      const { db, inserted } = fakeDb(t);
      await report(db, BOT_DEF);
      expect(inserted[0]).toMatchObject({ status: "dismissed" });
    }
  });

  it("2ª denúncia (até com duplicatas antigas): mesma resposta, sem gravar — igual para a verdadeira", async () => {
    const opsOf = async (id: string) => {
      const t = tables();
      t.reports.push(
        { reporter_user_id: "r", definition_id: id },
        { reporter_user_id: "r", definition_id: id },
      );
      const { db, inserted, ops } = fakeDb(t);
      await expect(report(db, id)).resolves.toEqual({ ok: true });
      expect(inserted).toEqual([]);
      return ops;
    };
    expect(await opsOf(TRUTH_DEF)).toEqual(await opsOf(BOT_DEF));
  });

  it("texto vazio ou longo demais vira texto válido (1..500) — também na verdadeira", async () => {
    for (const id of [BOT_DEF, TRUTH_DEF]) {
      for (const text of ["", "x".repeat(900)]) {
        const t = tables();
        t.definitions.find((d) => d.id === id)!.text = text;
        const { db, inserted } = fakeDb(t);
        await report(db, id);
        const saved = String(inserted[0]!.definition_text);
        expect(saved.length).toBeGreaterThanOrEqual(1);
        expect(saved.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it("falha na sala/autor: registra mesmo assim (sem apelido) e loga", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, inserted } = fakeDb(tables(), { "players.select": "boom" });
    await expect(report(db, HUMAN_DEF)).resolves.toEqual({ ok: true });
    expect(inserted[0]).toMatchObject({
      offender_player_id: "p-ana",
      offender_nickname: null,
    });
    expect(log).toHaveBeenCalled();
  });

  it("definição inexistente, checagem de duplicata ou gravação falhando → erro, nunca sucesso", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = "55555555-5555-4555-8555-555555555555";
    await expect(report(fakeDb(tables()).db, missing)).rejects.toThrow(
      /não encontrada/,
    );
    for (const fail of [
      { "definitions.select": "boom" },
      { "reports.select": "boom" },
      { "reports.insert": "boom" },
    ])
      await expect(report(fakeDb(tables(), fail).db, BOT_DEF)).rejects.toThrow(
        /Não foi possível enviar a denúncia/,
      );
  });

  it("id que não é uuid → recusado na validação", () => {
    expect(() =>
      ReportInput.parse({ definitionId: "x", reason: "spam" }),
    ).toThrow();
  });
});
