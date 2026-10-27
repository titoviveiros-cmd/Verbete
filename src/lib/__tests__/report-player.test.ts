import { describe, expect, it, vi } from "vitest";
import { filePlayerReport, PlayerReportInput } from "@/lib/report-player";
import {
  PLAYER_REPORT_REASONS,
  isPlayerReport,
  playerReasonLabel,
} from "@/lib/report-player-reasons";

// Denúncia de jogador (apelido/comportamento) — rodada 2A da conformidade
// Google Play. Sem migration: reaproveita reports com definition_id nulo e
// motivo "player_*". Alvo, sala e apelido vêm do BANCO; só quem está na
// mesma sala denuncia; 1 denúncia por denunciante + alvo.

type Row = Record<string, unknown>;
/** Banco falso: from().select().eq()/is()…maybeSingle()/limit() e insert(). */
function fakeDb(
  tables: Record<string, Row[]>,
  fail: Partial<Record<string, unknown>> = {},
) {
  const inserted: Row[] = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const rows = () =>
      (tables[table] ?? []).filter((r) =>
        filters.every(([c, v]) => (r[c] ?? null) === v),
      );
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => (filters.push([col, val]), q),
      is: (col: string, val: unknown) => (filters.push([col, val]), q),
      maybeSingle: async () => {
        const error = fail[`${table}.select`] ?? null;
        return { data: error ? null : (rows()[0] ?? null), error };
      },
      limit: async (n: number) => {
        const error = fail[`${table}.select`] ?? null;
        return { data: error ? null : rows().slice(0, n), error };
      },
      insert: async (row: Row) => {
        const error = fail[`${table}.insert`] ?? null;
        if (!error) inserted.push({ table, ...row });
        return { error };
      },
    };
    return q;
  };
  return { db: { from } as never, inserted };
}

const ROOM = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOM = "22222222-2222-4222-8222-222222222222";
const ME = "00000000-0000-4000-8000-0000000000aa";
const ANA = "00000000-0000-4000-8000-00000000a0a0";
const tables = (): Record<string, Row[]> => ({
  rooms: [{ id: ROOM, code: "4321", current_round: 3 }],
  players: [
    {
      id: "p-eu",
      room_id: ROOM,
      nickname: "Eu",
      avatar: "🦊",
      user_id: ME,
      is_bot: false,
    },
    {
      id: "p-ana",
      room_id: ROOM,
      nickname: "Xingamento",
      avatar: "🐸",
      user_id: ANA,
      is_bot: false,
    },
    {
      id: "bot-1",
      room_id: ROOM,
      nickname: "Robô",
      avatar: "🤖",
      user_id: null,
      is_bot: true,
    },
    {
      id: "p-longe",
      room_id: OTHER_ROOM,
      nickname: "Outra",
      avatar: "🐼",
      user_id: "u-x",
      is_bot: false,
    },
  ],
  reports: [],
});

describe("filePlayerReport", () => {
  it("grava a denúncia com apelido, sala e conta resolvidos NO BANCO", async () => {
    const { db, inserted } = fakeDb(tables());
    await expect(
      filePlayerReport(db, ME, { playerId: "p-ana", reason: "nickname" }),
    ).resolves.toEqual({ ok: true });
    expect(inserted).toEqual([
      {
        table: "reports",
        definition_id: null,
        definition_text: "Apelido: Xingamento · avatar: 🐸",
        room_id: ROOM,
        room_code: "4321",
        round: 3,
        offender_player_id: "p-ana",
        offender_nickname: "Xingamento",
        offender_user_id: ANA,
        reporter_user_id: ME,
        reason: "player_nickname",
      },
    ]);
  });

  it("anti-spam: a 2ª denúncia do mesmo denunciante contra o mesmo jogador não grava", async () => {
    const t = tables();
    t.reports = [
      {
        id: "r1",
        reporter_user_id: ME,
        offender_player_id: "p-ana",
        definition_id: null,
      },
    ];
    const { db, inserted } = fakeDb(t);
    await expect(
      filePlayerReport(db, ME, { playerId: "p-ana", reason: "behavior" }),
    ).resolves.toEqual({ ok: true });
    expect(inserted).toEqual([]);
  });

  it("denúncia antiga de DEFINIÇÃO do mesmo autor não bloqueia a de jogador", async () => {
    const t = tables();
    t.reports = [
      {
        id: "r1",
        reporter_user_id: ME,
        offender_player_id: "p-ana",
        definition_id: "d-1",
      },
    ];
    const { db, inserted } = fakeDb(t);
    await filePlayerReport(db, ME, { playerId: "p-ana", reason: "nickname" });
    expect(inserted).toHaveLength(1);
  });

  it("quem não está na sala do alvo não denuncia (barra varredura pela API)", async () => {
    const { db, inserted } = fakeDb(tables());
    await expect(
      filePlayerReport(db, ME, { playerId: "p-longe", reason: "nickname" }),
    ).rejects.toThrow(/Só quem está na sala/);
    expect(inserted).toEqual([]);
  });

  it("não denuncia a si mesmo nem bots; jogador inexistente → erro claro", async () => {
    const { db, inserted } = fakeDb(tables());
    await expect(
      filePlayerReport(db, ME, { playerId: "p-eu", reason: "other" }),
    ).rejects.toThrow(/a si mesmo/);
    await expect(
      filePlayerReport(db, ME, { playerId: "bot-1", reason: "other" }),
    ).rejects.toThrow(/Bots/);
    await expect(
      filePlayerReport(db, ME, { playerId: "p-nada", reason: "other" }),
    ).rejects.toThrow(/não encontrado/);
    expect(inserted).toEqual([]);
  });

  it("falha de banco na checagem ou na gravação → erro genérico, nada gravado", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const op of ["players.select", "reports.select", "reports.insert"]) {
      const { db, inserted } = fakeDb(tables(), { [op]: { code: "XX" } });
      await expect(
        filePlayerReport(db, ME, { playerId: "p-ana", reason: "nickname" }),
        op,
      ).rejects.toThrow("Não foi possível enviar a denúncia.");
      expect(inserted, op).toEqual([]);
    }
    errors.mockRestore();
  });
});

describe("entrada e rótulos da denúncia de jogador", () => {
  it("o cliente só escolhe quem e por quê — campos a mais são descartados", () => {
    const parsed = PlayerReportInput.parse({
      playerId: "p-ana",
      reason: "behavior",
      nickname: "forjado",
      offenderUserId: "u-forjado",
    });
    expect(parsed).toEqual({ playerId: "p-ana", reason: "behavior" });
    expect(PlayerReportInput.parse({ playerId: "p-ana" }).reason).toBe(
      "nickname",
    );
    expect(() =>
      PlayerReportInput.parse({ playerId: "", reason: "x" }),
    ).toThrow();
  });

  it("os motivos do modal são exatamente os aceitos pelo servidor", () => {
    expect(Object.keys(PLAYER_REPORT_REASONS).sort()).toEqual(
      [...PlayerReportInput.shape.reason.removeDefault().options].sort(),
    );
  });

  it("o painel distingue jogador de definição e mostra o motivo legível", () => {
    expect(isPlayerReport({ reason: "player_nickname" })).toBe(true);
    expect(isPlayerReport({ reason: "inappropriate" })).toBe(false);
    expect(playerReasonLabel("player_nickname")).toBe(
      "Apelido ofensivo ou impróprio",
    );
    expect(playerReasonLabel("player_desconhecido")).toBe(
      "player_desconhecido",
    );
  });
});
