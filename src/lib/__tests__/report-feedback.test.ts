import { describe, expect, it } from "vitest";
import {
  AppealInput,
  REMOVED_DEFINITION_TEXT,
  listAppealsForReview,
  listMyNotices,
  listMyReports,
  removeReportedContent,
  resolveAppeal,
  submitAppeal,
} from "@/lib/report-feedback";

// Lado do servidor do retorno/aviso/recurso (ECA Digital arts. 28–30).
// Banco falso com o subconjunto do supabase-js que o módulo usa.

type Row = Record<string, unknown>;
function fakeDb(
  tables: Record<string, Row[]>,
  fail: Record<string, unknown> = {},
) {
  const log: Array<{
    op: string;
    table: string;
    row?: Row;
    filters?: unknown;
  }> = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const rows = () =>
      (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const run = async () => {
      if (patch) {
        const error = fail[`${table}.update`] ?? null;
        if (!error) {
          for (const r of rows()) Object.assign(r, patch);
          log.push({ op: "update", table, row: patch });
        }
        return { error };
      }
      const error = fail[`${table}.select`] ?? null;
      return { data: error ? null : rows(), error };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (
        filters.push((r) => (r[c] ?? null) === v),
        q
      ),
      in: (c: string, vs: unknown[]) => (
        filters.push((r) => vs.includes(r[c])),
        q
      ),
      order: () => q,
      limit: async (n: number) => {
        const res = await run();
        return {
          ...res,
          data: res.data ? (res.data as Row[]).slice(0, n) : null,
        };
      },
      maybeSingle: async () => {
        const res = await run();
        return {
          ...res,
          data: res.data ? ((res.data as Row[])[0] ?? null) : null,
        };
      },
      insert: async (row: Row) => {
        const error = fail[`${table}.insert`] ?? null;
        if (!error) {
          (tables[table] ??= []).push({ ...row });
          log.push({ op: "insert", table, row });
        }
        return { error };
      },
      update: (p: Row) => ((patch = p), q),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        run().then(ok, ko),
    };
    return q;
  };
  return { db: { from } as never, log, tables };
}

const D = 24 * 3600 * 1000;
const T0 = Date.parse("2026-11-11T12:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const ME = "00000000-0000-4000-8000-0000000000aa";
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const A1 = "33333333-3333-4333-8333-333333333333";

const tables = (): Record<string, Row[]> => ({
  reports: [
    {
      id: R1,
      definition_id: "def-1",
      definition_text: "liga 11987654321",
      offender_player_id: "p-me",
      offender_user_id: ME,
      reporter_user_id: "rep",
      reason: "harassment",
      status: "resolved",
      action: "ban",
      decision_reason: "dados_pessoais",
      review_kind: "human",
      resolved_at: iso(T0),
      created_at: iso(T0 - D),
      offender_nickname: "Eu",
    },
    {
      id: R2,
      definition_id: null,
      definition_text: "Apelido: X",
      offender_player_id: "p-me",
      offender_user_id: ME,
      reporter_user_id: "rep",
      reason: "player_nickname",
      status: "dismissed",
      action: "dismiss",
      decision_reason: null,
      review_kind: "human",
      resolved_at: iso(T0),
      created_at: iso(T0 - D),
      offender_nickname: "X",
    },
  ],
  moderation_appeals: [],
  banned_players: [{ id: "b1", report_id: R1, expires_at: null }],
  definitions: [{ id: "def-1", text: "liga 11987654321" }],
  players: [{ id: "p-me", nickname: "Palavrão" }],
});

describe("listMyNotices / listMyReports", () => {
  it("autor só recebe aviso das medidas (ban/remoção), nunca do descarte", async () => {
    const { db } = fakeDb(tables());
    const { notices } = await listMyNotices(db, ME, T0 + D);
    expect(notices.map((n) => n.reportId)).toEqual([R1]);
    expect(notices[0]!.canAppeal).toBe(true);
  });
  it("denunciante vê o estado das próprias denúncias", async () => {
    const { db } = fakeDb(tables());
    const { reports } = await listMyReports(db, "rep", T0 + D);
    expect(reports).toHaveLength(2);
    expect(reports.every((r) => !("offender_user_id" in r))).toBe(true);
  });
  it("erro do banco vira mensagem genérica", async () => {
    const { db } = fakeDb(tables(), { "reports.select": { message: "x" } });
    await expect(listMyReports(db, "rep")).rejects.toThrow(/Não foi possível/);
  });
});

describe("submitAppeal", () => {
  it("valida o texto (5–1000)", () => {
    expect(() => AppealInput.parse({ reportId: R1, text: "oi" })).toThrow();
    expect(
      AppealInput.parse({ reportId: R1, text: "  não fui eu  " }).text,
    ).toBe("não fui eu");
  });
  it("registra o recurso do autor dentro do prazo, uma vez só", async () => {
    const { db, tables: t } = fakeDb(tables());
    await submitAppeal(db, ME, { reportId: R1, text: "não fui eu" }, T0 + D);
    expect(t.moderation_appeals).toHaveLength(1);
    expect(t.moderation_appeals![0]).toMatchObject({
      report_id: R1,
      user_id: ME,
    });
    await expect(
      submitAppeal(db, ME, { reportId: R1, text: "de novo aqui" }, T0 + D),
    ).rejects.toThrow(/já contestou/);
  });
  it("recusa quem não é o autor, descarte e fora do prazo", async () => {
    const { db } = fakeDb(tables());
    await expect(
      submitAppeal(db, "outro", { reportId: R1, text: "não fui eu" }, T0),
    ).rejects.toThrow(/não encontrado/);
    await expect(
      submitAppeal(db, ME, { reportId: R2, text: "não fui eu" }, T0),
    ).rejects.toThrow(/não tem recurso/);
    await expect(
      submitAppeal(db, ME, { reportId: R1, text: "não fui eu" }, T0 + 20 * D),
    ).rejects.toThrow(/prazo/);
  });
  it("corrida (unique violation) vira 'já contestou'", async () => {
    const { db } = fakeDb(tables(), {
      "moderation_appeals.insert": { code: "23505" },
    });
    await expect(
      submitAppeal(db, ME, { reportId: R1, text: "não fui eu" }, T0),
    ).rejects.toThrow(/já contestou/);
  });
});

describe("removeReportedContent", () => {
  it("definição vira o aviso de remoção", async () => {
    const { db, tables: t } = fakeDb(tables());
    await removeReportedContent(db, {
      definition_id: "def-1",
      offender_player_id: "p-me",
    });
    expect(t.definitions![0]!.text).toBe(REMOVED_DEFINITION_TEXT);
    expect(t.players![0]!.nickname).toBe("Palavrão");
  });
  it("apelido vira 'Jogador'", async () => {
    const { db, tables: t } = fakeDb(tables());
    await removeReportedContent(db, {
      definition_id: null,
      offender_player_id: "p-me",
    });
    expect(t.players![0]!.nickname).toBe("Jogador");
  });
});

describe("resolveAppeal", () => {
  const withAppeal = () => {
    const t = tables();
    t.moderation_appeals = [
      {
        id: A1,
        report_id: R1,
        user_id: ME,
        text: "não fui eu",
        status: "pending",
        decision_note: null,
        decided_at: null,
        created_at: iso(T0 + D),
      },
    ];
    return t;
  };
  it("reverter uma suspensão encerra o ban ligado à denúncia", async () => {
    const { db, tables: t } = fakeDb(withAppeal());
    await resolveAppeal(
      db,
      "admin",
      { appealId: A1, outcome: "reversed", note: "erro nosso" },
      T0 + 2 * D,
    );
    expect(t.banned_players![0]!.expires_at).toBe(iso(T0 + 2 * D));
    expect(t.moderation_appeals![0]).toMatchObject({
      status: "reversed",
      decision_note: "erro nosso",
      decided_by: "admin",
    });
  });
  it("manter a medida não mexe no ban; recurso decidido não volta", async () => {
    const { db, tables: t } = fakeDb(withAppeal());
    await resolveAppeal(db, "admin", {
      appealId: A1,
      outcome: "upheld",
      note: "regra clara",
    });
    expect(t.banned_players![0]!.expires_at).toBeNull();
    await expect(
      resolveAppeal(db, "admin", {
        appealId: A1,
        outcome: "reversed",
        note: "x",
      }),
    ).rejects.toThrow(/já foi decidido/);
  });
  it("painel lista o recurso com a denúncia e o prazo de resposta", async () => {
    const { db } = fakeDb(withAppeal());
    const { appeals } = await listAppealsForReview(db);
    expect(appeals).toHaveLength(1);
    expect(appeals[0]).toMatchObject({
      reportId: R1,
      content: "liga 11987654321",
      action: "ban",
      dueAt: iso(T0 + D + 15 * D),
    });
  });
});
