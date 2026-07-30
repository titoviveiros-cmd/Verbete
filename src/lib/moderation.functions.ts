import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// ============================================================
// Reportar uma definição inadequada
// ============================================================
const ReportInput = z.object({
  definitionId: z.string().uuid(),
  definitionText: z.string().trim().min(1).max(500),
  roomId: z.string().uuid().nullable().optional(),
  roomCode: z.string().trim().min(1).max(16).nullable().optional(),
  round: z.number().int().min(0).max(999).nullable().optional(),
  offenderPlayerId: z.string().trim().min(1).max(64),
  offenderNickname: z.string().trim().min(1).max(64).nullable().optional(),
  reason: z
    .enum(["inappropriate", "spam", "harassment", "other"])
    .default("inappropriate"),
});

export const reportDefinition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => ReportInput.parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;

    // Anti-spam: 1 report por usuário+definição
    const { data: existing } = await supabaseAdmin
      .from("reports")
      .select("id")
      .eq("reporter_user_id", userId)
      .eq("definition_id", data.definitionId)
      .maybeSingle();
    if (existing) return { ok: true as const, already: true };

    const { error } = await supabaseAdmin.from("reports").insert({
      definition_id: data.definitionId,
      definition_text: data.definitionText,
      room_id: data.roomId ?? null,
      room_code: data.roomCode ?? null,
      round: data.round ?? null,
      offender_player_id: data.offenderPlayerId,
      offender_nickname: data.offenderNickname ?? null,
      reporter_user_id: userId,
      reason: data.reason,
    });
    if (error) {
      console.error("[reportDefinition] insert failed", error);
      throw new Error("Não foi possível enviar a denúncia.");
    }
    return { ok: true as const, already: false };
  });

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
// Admin: resolver report (dismiss ou ban)
// ============================================================
const ResolveInput = z.object({
  reportId: z.string().uuid(),
  action: z.enum(["dismiss", "ban"]),
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

    if (data.action === "ban") {
      const expiresAt =
        data.banDays && data.banDays > 0
          ? new Date(Date.now() + data.banDays * 86400 * 1000).toISOString()
          : null;
      const banRow: {
        reason: string;
        banned_by: string;
        expires_at: string | null;
        player_id?: string;
        user_id?: string;
      } = {
        reason: data.banReason ?? `report:${report.id}`,
        banned_by: userId,
        expires_at: expiresAt,
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
        status: data.action === "ban" ? "resolved" : "dismissed",
        resolved_by: userId,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", data.reportId);
    if (updErr) throw new Error("Falha ao atualizar report.");

    return { ok: true as const };
  });
