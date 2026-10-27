import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deleteAccountData } from "@/lib/account-deletion";

/**
 * Deleta a conta do usuário autenticado (lógica e o que fica nas salas em
 * account-deletion.ts; /privacy, /delete-account e /support descrevem
 * exatamente isto — manter alinhados).
 *
 * Apple App Store Guideline 5.1.1(v) e Google Play exigem exclusão in-app
 * para apps com criação de conta.
 */
export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => deleteAccountData(supabaseAdmin, context.userId));

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
