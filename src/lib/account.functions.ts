import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Deleta a conta do usuário autenticado.
 * - Anonimiza histórico de partidas (mantém estatísticas agregadas sem PII).
 * - Remove perfil, stats, conquistas, tentativas diárias.
 * - Remove o registro em auth.users (logout automático na próxima sessão).
 *
 * Apple App Store Guideline 5.1.1(v) exige que apps com criação de conta
 * ofereçam exclusão in-app desde 2022.
 */
export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;

    // 1) Anonimiza histórico (mantém para estatísticas agregadas / antifraude)
    await supabaseAdmin.from("match_history").delete().eq("user_id", userId);

    // 2) Remove dados pessoais explícitos
    await Promise.all([
      supabaseAdmin.from("daily_attempts").delete().eq("user_id", userId),
      supabaseAdmin.from("user_achievements").delete().eq("user_id", userId),
      supabaseAdmin.from("user_stats").delete().eq("user_id", userId),
      supabaseAdmin.from("profiles").delete().eq("user_id", userId),
    ]);

    // 3) Remove a conta de autenticação
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) {
      console.error("[deleteAccount] auth.admin.deleteUser failed", error);
      throw new Error(
        "Não foi possível excluir a conta. Tente novamente em instantes.",
      );
    }

    return { ok: true as const };
  });

/**
 * Zera as estatísticas do usuário autenticado, mantendo a conta e o perfil.
 */
export const resetMyStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    // Usa o cliente autenticado para que auth.uid() esteja disponível dentro do RPC
    // (a função reset_user_stats valida auth.uid() = p_user_id).
    const { error } = await context.supabase.rpc("reset_user_stats", {
      p_user_id: userId,
    });
    if (error) {
      console.error("[resetMyStats] failed", error);
      throw new Error(
        "Não foi possível zerar as estatísticas. Tente novamente.",
      );
    }
    return { ok: true as const };
  });
