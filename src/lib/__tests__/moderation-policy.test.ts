import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPEAL_WINDOW_DAYS,
  DECISION_REASON_KEYS,
  REPORT_ACTIONS,
  REPORT_REVIEW_HOURS,
  appealError,
  offenderNotice,
  reporterView,
  type AppealRow,
  type ReportRow,
} from "@/lib/moderation-policy";

// ECA Digital arts. 28–30 + L14852 art. 16 I–III (11/11/2026): retorno ao
// denunciante, aviso ao autor com motivo e "análise humana", recurso com
// prazo. Regras puras — o servidor (report-feedback.ts) só busca as linhas.

const H = 3600 * 1000;
const D = 24 * H;
const T0 = Date.parse("2026-11-11T12:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const ME = "00000000-0000-4000-8000-0000000000aa";

const base = (over: Partial<ReportRow> = {}): ReportRow => ({
  id: "r1",
  definition_id: "d1",
  definition_text: "texto denunciado",
  reason: "harassment",
  status: "pending",
  action: null,
  decision_reason: null,
  review_kind: "human",
  resolved_at: null,
  created_at: iso(T0),
  reporter_user_id: "rep",
  offender_user_id: ME,
  ...over,
});

describe("reporterView (retorno ao denunciante)", () => {
  it("pendente: em análise, com prazo de 72 h", () => {
    const v = reporterView(base(), T0 + H);
    expect(v.state).toBe("em_analise");
    expect(v.dueAt).toBe(iso(T0 + REPORT_REVIEW_HOURS * H));
    expect(v.overdue).toBe(false);
    expect(v.resultLabel).toMatch(/72 h/);
  });
  it("pendente além do prazo: marcado como atrasado", () => {
    expect(reporterView(base(), T0 + 73 * H).overdue).toBe(true);
  });
  it("cédula verdadeira descartada na hora NÃO aparece como descartada durante a partida", () => {
    const truth = base({
      status: "dismissed",
      action: "dismiss",
      review_kind: "automated",
      resolved_at: iso(T0),
    });
    const fake = base({ id: "r2" });
    // nos primeiros 60 min, verdadeira e falsa pendente são indistinguíveis
    for (const t of [T0, T0 + 30 * 60 * 1000, T0 + 59 * 60 * 1000]) {
      const a = reporterView(truth, t);
      const b = reporterView(fake, t);
      expect({ ...a, id: "" }).toEqual({ ...b, id: "" });
    }
    const later = reporterView(truth, T0 + 2 * H);
    expect(later.state).toBe("sem_violacao");
    expect(later.reviewKind).toBe("automatizada");
  });
  it("medida aplicada aparece como medida, com análise humana", () => {
    const v = reporterView(
      base({ status: "resolved", action: "ban", resolved_at: iso(T0 + 5 * H) }),
      T0 + 6 * H,
    );
    expect(v.state).toBe("medida_aplicada");
    expect(v.reviewKind).toBe("humana");
  });
  it("nunca expõe autor, texto ou quem decidiu", () => {
    const v = reporterView(base(), T0) as Record<string, unknown>;
    expect(Object.keys(v).sort()).toEqual(
      [
        "createdAt",
        "dueAt",
        "id",
        "kind",
        "overdue",
        "resultLabel",
        "reviewKind",
        "state",
      ].sort(),
    );
  });
  it("denúncia de jogador (sem definição) é do tipo jogador", () => {
    expect(reporterView(base({ definition_id: null }), T0).kind).toBe(
      "jogador",
    );
  });
});

describe("offenderNotice (aviso ao autor, art. 30)", () => {
  const removed = base({
    status: "resolved",
    action: "remove_content",
    decision_reason: "dados_pessoais",
    resolved_at: iso(T0),
  });
  it("descarte não gera aviso", () => {
    expect(
      offenderNotice(
        base({ status: "dismissed", action: "dismiss", resolved_at: iso(T0) }),
        null,
        T0,
      ),
    ).toBeNull();
  });
  it("remoção: motivo, análise humana, prazo de recurso", () => {
    const n = offenderNotice(removed, null, T0 + D)!;
    expect(n.actionLabel).toMatch(/removido/);
    expect(n.reasonLabel).toMatch(/Dados pessoais/);
    expect(n.reviewKind).toBe("humana");
    expect(n.appealDeadline).toBe(iso(T0 + APPEAL_WINDOW_DAYS * D));
    expect(n.canAppeal).toBe(true);
    expect(n.content).toBe("texto denunciado");
    expect(JSON.stringify(n)).not.toContain('"rep"'); // nunca o denunciante
  });
  it("depois do prazo não pode mais recorrer", () => {
    expect(
      offenderNotice(removed, null, T0 + (APPEAL_WINDOW_DAYS + 1) * D)!
        .canAppeal,
    ).toBe(false);
  });
  it("com recurso: mostra o estado e a resposta só depois de decidido", () => {
    const ap: AppealRow = {
      id: "a1",
      report_id: "r1",
      user_id: ME,
      text: "não foi isso",
      status: "pending",
      decision_note: "rascunho interno",
      decided_at: null,
      created_at: iso(T0 + D),
    };
    const p = offenderNotice(removed, ap, T0 + 2 * D)!;
    expect(p.canAppeal).toBe(false);
    expect(p.appeal?.statusLabel).toMatch(/em análise/);
    expect(p.appeal?.note).toBeNull();
    const r = offenderNotice(
      removed,
      { ...ap, status: "reversed", decision_note: "erro nosso" },
      T0 + 3 * D,
    )!;
    expect(r.appeal?.statusLabel).toMatch(/desfeita/);
    expect(r.appeal?.note).toBe("erro nosso");
  });
});

describe("appealError", () => {
  const banned = base({
    status: "resolved",
    action: "ban",
    decision_reason: "assedio",
    resolved_at: iso(T0),
  });
  it("aceita o autor dentro do prazo", () => {
    expect(appealError(banned, null, ME, T0 + D)).toBeNull();
  });
  it("recusa outra pessoa, descarte, recurso repetido e fora do prazo", () => {
    expect(appealError(banned, null, "outro", T0)).toMatch(/não encontrado/);
    expect(appealError(null, null, ME, T0)).toMatch(/não encontrado/);
    expect(
      appealError(
        base({ action: "dismiss", resolved_at: iso(T0) }),
        null,
        ME,
        T0,
      ),
    ).toMatch(/não tem recurso/);
    expect(
      appealError(
        banned,
        {
          id: "a",
          report_id: "r1",
          user_id: ME,
          text: "x",
          status: "pending",
          decision_note: null,
          decided_at: null,
          created_at: iso(T0),
        },
        ME,
        T0,
      ),
    ).toMatch(/já contestou/);
    expect(appealError(banned, null, ME, T0 + 16 * D)).toMatch(/15 dias/);
  });
});

describe("paridade com a migration", () => {
  const sql = readFileSync(
    "supabase/migrations/20261111130000_denuncia_retorno_recurso.sql",
    "utf8",
  );
  it("motivos e medidas do app = CHECKs do banco", () => {
    for (const k of DECISION_REASON_KEYS) expect(sql).toContain(`'${k}'`);
    for (const a of REPORT_ACTIONS) expect(sql).toContain(`'${a}'`);
  });
  it("tabela de recursos fechada para o cliente", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON public\.moderation_appeals FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });
});
