// V3 mínima: acesso real (service role) para a guarda de ./room-guard.ts.
// Só Deno — a lógica de decisão fica no arquivo puro, testada no Vitest.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { GuardDeps, Identity } from "./room-guard.ts";

export function supabaseGuardDeps(admin: SupabaseClient): GuardDeps {
  return {
    async readConfig(key) {
      const { data, error } = await admin
        .from("app_config")
        .select("value")
        .eq("key", key)
        .maybeSingle();
      if (error) throw new Error(`app_config: ${error.code ?? ""}`);
      const v = (data as { value?: unknown } | null)?.value;
      return typeof v === "string" ? v : null;
    },
    async identify(token): Promise<Identity> {
      // Valida o JWT no serviço de auth (conta ou convidado anônimo). A chave
      // anon, token vencido ou forjado → sem usuário. Auth fora do ar (5xx,
      // rede) é outra coisa: 'error', para não confundir com abuso.
      try {
        const { data, error } = await admin.auth.getUser(token);
        if (!error && data?.user?.id) return { kind: "user", userId: data.user.id };
        const e = error as { status?: unknown; name?: unknown } | null;
        const status = Number(e?.status ?? 0);
        return status >= 500 || e?.name === "AuthRetryableFetchError"
          ? { kind: "error" }
          : { kind: "none" };
      } catch {
        return { kind: "error" };
      }
    },
    async isMember(roomId, userId) {
      const { data, error } = await admin
        .from("players")
        .select("id")
        .eq("room_id", roomId)
        .eq("user_id", userId)
        .is("kicked_at", null)
        .limit(1);
      if (error) throw new Error(`players: ${error.code ?? ""}`);
      return (data ?? []).length > 0;
    },
    async takeQuota(key, windowS) {
      const { data, error } = await admin.rpc("ai_quota_add", {
        p_key: key,
        p_window_s: windowS,
      });
      if (error) throw new Error(`ai_quota_add: ${error.code ?? ""}`);
      const n = Number(data);
      if (!Number.isFinite(n)) throw new Error("ai_quota_add: retorno inválido");
      return n;
    },
  };
}
