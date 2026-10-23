import { describe, expect, it } from "vitest";
import { fileReport, ReportInput } from "@/lib/report-definition";

// Denúncia durante a votação (RC Android 2.1.0, teste real das 4 ações): a
// cédula chega SEM autor (player_id "") e o servidor recusava toda denúncia
// ("offenderPlayerId: String must contain at least 1 character(s)"). Agora o
// servidor acha autor, texto e sala no banco pelo id da cédula.

type Row = Record<string, unknown>;
/** Banco falso: from().select().eq()…maybeSingle() e insert(). */
function fakeDb(tables: Record<string, Row[]>, insertError: unknown = null) {
  const inserted: Row[] = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => (filters.push([col, val]), q),
      maybeSingle: async () => ({
        data:
          (tables[table] ?? []).find((r) =>
            filters.every(([c, v]) => r[c] === v),
          ) ?? null,
        error: null,
      }),
      insert: async (row: Row) => {
        if (!insertError) inserted.push({ table, ...row });
        return { error: insertError };
      },
    };
    return q;
  };
  return { db: { from } as never, inserted };
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

describe("denúncia de definição", () => {
  it("cédula da votação (autor oculto) é aceita — o servidor recusava", () => {
    expect(() => ReportInput.parse(votingPayload(BOT_DEF))).not.toThrow();
    expect(ReportInput.parse(votingPayload(BOT_DEF))).toEqual({
      definitionId: BOT_DEF,
      reason: "spam",
    });
  });

  it("autor, texto e sala vêm do BANCO — nada do que o cliente afirma", async () => {
    const { db, inserted } = fakeDb(tables());
    const input = ReportInput.parse({
      ...votingPayload(HUMAN_DEF),
      offenderPlayerId: "vitima",
    });
    await expect(fileReport(db, "reporter-1", input)).resolves.toEqual({
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

  it("definição verdadeira: MESMA resposta e nada registrado", async () => {
    const { db, inserted } = fakeDb(tables());
    const real = await fileReport(
      db,
      "r",
      ReportInput.parse(votingPayload(BOT_DEF)),
    );
    const truth = await fileReport(
      db,
      "r",
      ReportInput.parse(votingPayload(TRUTH_DEF)),
    );
    expect(truth).toEqual(real);
    expect(inserted.map((r) => r.definition_id)).toEqual([BOT_DEF]);
  });

  it("2ª denúncia da mesma cédula: mesma resposta, sem duplicar", async () => {
    const t = tables();
    t.reports.push({ reporter_user_id: "r", definition_id: BOT_DEF });
    const { db, inserted } = fakeDb(t);
    await expect(
      fileReport(db, "r", ReportInput.parse(votingPayload(BOT_DEF))),
    ).resolves.toEqual({ ok: true });
    expect(inserted).toEqual([]);
  });

  it("definição inexistente ou falha ao gravar → erro, nunca sucesso", async () => {
    const missing = "55555555-5555-4555-8555-555555555555";
    await expect(
      fileReport(
        fakeDb(tables()).db,
        "r",
        ReportInput.parse(votingPayload(missing)),
      ),
    ).rejects.toThrow(/não encontrada/);
    await expect(
      fileReport(
        fakeDb(tables(), { message: "boom" }).db,
        "r",
        ReportInput.parse(votingPayload(BOT_DEF)),
      ),
    ).rejects.toThrow(/Não foi possível enviar a denúncia/);
  });

  it("id que não é uuid → recusado na validação", () => {
    expect(() =>
      ReportInput.parse({ definitionId: "x", reason: "spam" }),
    ).toThrow();
  });
});
