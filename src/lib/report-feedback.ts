// Retorno da denúncia, aviso ao autor e recurso (ECA Digital arts. 28–30;
// L14852 art. 16 I–III) — lado do servidor (11/11/2026). Tudo pelo service
// role: reports e moderation_appeals NÃO são legíveis pelo cliente (migration
// 20261023190000_reports_server_only e 20261111130000_denuncia_retorno_recurso).
// Cada pessoa só recebe a VISÃO calculada em moderation-policy.ts:
//   * denunciante: estado e prazo, nunca o autor nem quem decidiu;
//   * autor: o que foi removido, o motivo, se a análise foi humana, o prazo e
//     o recurso — nunca quem denunciou.
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  appealDueAt,
  appealError,
  isNoticeAction,
  offenderNotice,
  reporterView,
  type AppealRow,
  type OffenderNotice,
  type ReportRow,
  type ReporterView,
} from "@/lib/moderation-policy";

type Db = SupabaseClient<Database>;

const REPORT_COLS =
  "id, definition_id, definition_text, reason, status, action, decision_reason, review_kind, resolved_at, created_at, reporter_user_id, offender_user_id";
const APPEAL_COLS =
  "id, report_id, user_id, text, status, decision_note, decided_at, created_at";
const FAILED = "Não foi possível carregar agora. Tente de novo.";

export async function listMyReports(
  db: Db,
  userId: string,
  now = Date.now(),
): Promise<{ reports: ReporterView[] }> {
  const { data, error } = await db
    .from("reports")
    .select(REPORT_COLS)
    .eq("reporter_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("[listMyReports] select failed", error);
    throw new Error(FAILED);
  }
  return {
    reports: ((data ?? []) as ReportRow[]).map((r) => reporterView(r, now)),
  };
}

export async function listMyNotices(
  db: Db,
  userId: string,
  now = Date.now(),
): Promise<{ notices: OffenderNotice[] }> {
  const { data, error } = await db
    .from("reports")
    .select(REPORT_COLS)
    .eq("offender_user_id", userId)
    .in("action", ["remove_content", "ban"])
    .order("resolved_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("[listMyNotices] select failed", error);
    throw new Error(FAILED);
  }
  const rows = (data ?? []) as ReportRow[];
  if (rows.length === 0) return { notices: [] };
  const { data: appeals, error: aErr } = await db
    .from("moderation_appeals")
    .select(APPEAL_COLS)
    .in(
      "report_id",
      rows.map((r) => r.id),
    );
  if (aErr) {
    console.error("[listMyNotices] appeals failed", aErr);
    throw new Error(FAILED);
  }
  const byReport = new Map(
    ((appeals ?? []) as AppealRow[]).map((a) => [a.report_id, a]),
  );
  return {
    notices: rows
      .map((r) => offenderNotice(r, byReport.get(r.id) ?? null, now))
      .filter((n): n is OffenderNotice => n !== null),
  };
}

export const AppealInput = z.object({
  reportId: z.string().uuid(),
  text: z.string().trim().min(5).max(1000),
});
export type AppealInputData = z.infer<typeof AppealInput>;

export async function submitAppeal(
  db: Db,
  userId: string,
  input: AppealInputData,
  now = Date.now(),
): Promise<{ ok: true }> {
  const [rep, existing] = await Promise.all([
    db
      .from("reports")
      .select(REPORT_COLS)
      .eq("id", input.reportId)
      .maybeSingle(),
    db
      .from("moderation_appeals")
      .select(APPEAL_COLS)
      .eq("report_id", input.reportId)
      .maybeSingle(),
  ]);
  if (rep.error || existing.error) {
    console.error("[submitAppeal] lookup failed", rep.error ?? existing.error);
    throw new Error("Não foi possível enviar o recurso.");
  }
  const err = appealError(
    (rep.data as ReportRow | null) ?? null,
    (existing.data as AppealRow | null) ?? null,
    userId,
    now,
  );
  if (err) throw new Error(err);
  const { error } = await db.from("moderation_appeals").insert({
    report_id: input.reportId,
    user_id: userId,
    text: input.text,
  });
  if (error) {
    // 23505 = corrida com outro envio do mesmo recurso (report_id único).
    if ((error as { code?: string }).code === "23505")
      throw new Error("Você já contestou esta decisão.");
    console.error("[submitAppeal] insert failed", error);
    throw new Error("Não foi possível enviar o recurso.");
  }
  return { ok: true };
}

/** Texto que fica no lugar de uma definição removida pela moderação. */
export const REMOVED_DEFINITION_TEXT = "[removida pela moderação]";
/** Apelido que fica no lugar de um apelido removido pela moderação. */
export const REMOVED_NICKNAME = "Jogador";

/**
 * Remove o conteúdo denunciado (art. 29): a definição vira o aviso de
 * remoção; o apelido vira "Jogador". O texto original continua só na foto
 * da denúncia (reports.definition_text), para recurso e retenção legal.
 */
export async function removeReportedContent(
  db: Db,
  report: { definition_id: string | null; offender_player_id: string },
): Promise<void> {
  const res = report.definition_id
    ? await db
        .from("definitions")
        .update({ text: REMOVED_DEFINITION_TEXT })
        .eq("id", report.definition_id)
    : await db
        .from("players")
        .update({ nickname: REMOVED_NICKNAME })
        .eq("id", report.offender_player_id);
  if (res.error) {
    console.error("[removeReportedContent] update failed", res.error);
    throw new Error("Falha ao remover o conteúdo.");
  }
}

export type AppealForReview = {
  id: string;
  reportId: string;
  text: string;
  createdAt: string;
  dueAt: string;
  content: string;
  action: string | null;
  decisionReason: string | null;
  offenderNickname: string | null;
};

/** Painel: recursos pendentes (mais antigos primeiro), com a denúncia. */
export async function listAppealsForReview(
  db: Db,
): Promise<{ appeals: AppealForReview[] }> {
  const { data, error } = await db
    .from("moderation_appeals")
    .select(APPEAL_COLS)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.error("[listAppealsForReview] select failed", error);
    throw new Error("Não foi possível carregar os recursos.");
  }
  const appeals = (data ?? []) as AppealRow[];
  if (appeals.length === 0) return { appeals: [] };
  const { data: reps, error: rErr } = await db
    .from("reports")
    .select("id, definition_text, action, decision_reason, offender_nickname")
    .in(
      "id",
      appeals.map((a) => a.report_id),
    );
  if (rErr) {
    console.error("[listAppealsForReview] reports failed", rErr);
    throw new Error("Não foi possível carregar os recursos.");
  }
  const byId = new Map((reps ?? []).map((r) => [r.id, r]));
  return {
    appeals: appeals.map((a) => {
      const r = byId.get(a.report_id);
      return {
        id: a.id,
        reportId: a.report_id,
        text: a.text,
        createdAt: a.created_at,
        dueAt: appealDueAt(a.created_at),
        content: r?.definition_text ?? "—",
        action: r?.action ?? null,
        decisionReason: r?.decision_reason ?? null,
        offenderNickname: r?.offender_nickname ?? null,
      };
    }),
  };
}

export const ResolveAppealInput = z.object({
  appealId: z.string().uuid(),
  outcome: z.enum(["upheld", "reversed"]),
  note: z.string().trim().min(1).max(500),
});
export type ResolveAppealData = z.infer<typeof ResolveAppealInput>;

/**
 * Decide um recurso (L14852 art. 16 III). Reverter uma suspensão encerra o
 * ban ligado à denúncia (expires_at = agora; o registro fica para auditoria).
 * Conteúdo removido não volta para a partida (que já acabou); a reversão
 * fica registrada e aparece para o autor.
 */
export async function resolveAppeal(
  db: Db,
  adminId: string,
  input: ResolveAppealData,
  now = Date.now(),
): Promise<{ ok: true }> {
  const { data: appeal, error } = await db
    .from("moderation_appeals")
    .select(APPEAL_COLS)
    .eq("id", input.appealId)
    .maybeSingle();
  if (error || !appeal) throw new Error("Recurso não encontrado.");
  if ((appeal as AppealRow).status !== "pending")
    throw new Error("Este recurso já foi decidido.");
  const nowIso = new Date(now).toISOString();
  if (input.outcome === "reversed") {
    const { data: rep } = await db
      .from("reports")
      .select("id, action")
      .eq("id", (appeal as AppealRow).report_id)
      .maybeSingle();
    if (rep && isNoticeAction(rep.action) && rep.action === "ban") {
      const { error: banErr } = await db
        .from("banned_players")
        .update({ expires_at: nowIso })
        .eq("report_id", rep.id);
      if (banErr) {
        console.error("[resolveAppeal] unban failed", banErr);
        throw new Error("Falha ao desfazer a suspensão.");
      }
    }
  }
  const { error: updErr } = await db
    .from("moderation_appeals")
    .update({
      status: input.outcome,
      decision_note: input.note,
      decided_by: adminId,
      decided_at: nowIso,
    })
    .eq("id", input.appealId)
    .eq("status", "pending");
  if (updErr) throw new Error("Falha ao registrar a decisão do recurso.");
  return { ok: true };
}
