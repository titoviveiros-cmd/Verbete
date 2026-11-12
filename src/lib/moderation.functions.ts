import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fileReport, ReportInput } from "@/lib/report-definition";
import { filePlayerReport, PlayerReportInput } from "@/lib/report-player";
import {
  AppealInput,
  listAppealsForReview,
  listMyNotices,
  listMyReports,
  removeReportedContent,
  resolveAppeal,
  ResolveAppealInput,
  submitAppeal,
} from "@/lib/report-feedback";
import { DECISION_REASON_KEYS } from "@/lib/moderation-policy";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// ============================================================
// Reportar uma definição inadequada (lógica em report-definition.ts)
// ============================================================
export const reportDefinition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => ReportInput.parse(input))
  .handler(({ data, context }) =>
    fileReport(supabaseAdmin, context.userId, data),
  );

// ============================================================
// Reportar um jogador — apelido/comportamento (lógica em report-player.ts)
// ============================================================
export const reportPlayer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => PlayerReportInput.parse(input))
  .handler(({ data, context }) =>
    filePlayerReport(supabaseAdmin, context.userId, data),
  );

// ============================================================
// Admin: listar reports pendentes
// ============================================================
export const listPendingReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roles) throw new Error("Acesso restrito a administradores.");

    const { data, error } = await supabaseAdmin
      .from("reports")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      console.error("[listPendingReports] select failed", error);
      throw new Error("Não foi possível carregar as denúncias.");
    }
    return { reports: data ?? [] };
  });

// ============================================================
// Admin: resolver report (descartar, remover conteúdo ou banir).
// ECA Digital art. 30: remoção e ban exigem MOTIVO (decisionReason), que o
// autor vê no aviso, com "análise humana" e o prazo do recurso.
// ============================================================
const ResolveInput = z.object({
  reportId: z.string().uuid(),
  action: z.enum(["dismiss", "remove_content", "ban"]),
  decisionReason: z
    .enum(DECISION_REASON_KEYS as [string, ...string[]])
    .optional(),
  banScope: z.enum(["player", "account", "both"]).default("both"),
  banReason: z.string().trim().min(1).max(200).optional(),
  banDays: z.number().int().min(0).max(3650).optional(), // 0 = perma
});

export const resolveReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => ResolveInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!isAdmin) throw new Error("Acesso restrito a administradores.");

    const { data: report, error: rErr } = await supabaseAdmin
      .from("reports")
      .select("*")
      .eq("id", data.reportId)
      .maybeSingle();
    if (rErr || !report) throw new Error("Report não encontrado.");
    if (data.action !== "dismiss" && !data.decisionReason)
      throw new Error("Escolha o motivo da medida (o autor vai ver).");

    if (data.action === "remove_content")
      await removeReportedContent(supabaseAdmin, report);

    if (data.action === "ban") {
      const expiresAt =
        data.banDays && data.banDays > 0
          ? new Date(Date.now() + data.banDays * 86400 * 1000).toISOString()
          : null;
      const banRow: {
        reason: string;
        banned_by: string;
        expires_at: string | null;
        report_id: string;
        player_id?: string;
        user_id?: string;
      } = {
        reason: data.banReason ?? `report:${report.id}`,
        banned_by: userId,
        expires_at: expiresAt,
        report_id: report.id,
      };
      if (data.banScope !== "account")
        banRow.player_id = report.offender_player_id;
      if (data.banScope !== "player" && report.offender_user_id)
        banRow.user_id = report.offender_user_id;

      const { error: banErr } = await supabaseAdmin
        .from("banned_players")
        .insert(banRow);
      if (banErr) {
        console.error("[resolveReport] ban insert failed", banErr);
        throw new Error("Falha ao registrar o ban.");
      }

      // Remove player das salas ativas
      await supabaseAdmin
        .from("players")
        .delete()
        .eq("id", report.offender_player_id);
    }

    const { error: updErr } = await supabaseAdmin
      .from("reports")
      .update({
        status: data.action === "dismiss" ? "dismissed" : "resolved",
        action: data.action,
        decision_reason:
          data.action === "dismiss" ? null : (data.decisionReason ?? null),
        review_kind: "human",
        resolved_by: userId,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", data.reportId);
    if (updErr) throw new Error("Falha ao atualizar report.");

    return { ok: true as const };
  });

async function assertAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Acesso restrito a administradores.");
}

// ============================================================
// Denunciante: "Minhas denúncias" — estado e prazo (L14852 art. 16 II)
// ============================================================
export const getMyReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => listMyReports(supabaseAdmin, context.userId));

// ============================================================
// Autor: avisos de remoção/suspensão com motivo e recurso (art. 30)
// ============================================================
export const getMyModerationNotices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => listMyNotices(supabaseAdmin, context.userId));

export const appealModeration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => AppealInput.parse(input))
  .handler(({ data, context }) =>
    submitAppeal(supabaseAdmin, context.userId, data),
  );

// ============================================================
// Admin: recursos pendentes e decisão (L14852 art. 16 III)
// ============================================================
export const listPendingAppeals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    return listAppealsForReview(supabaseAdmin);
  });

export const decideAppeal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => ResolveAppealInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    return resolveAppeal(supabaseAdmin, context.userId, data);
  });
