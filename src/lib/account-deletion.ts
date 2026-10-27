// Exclusão da conta (Perfil → Zona de perigo → Excluir conta). Lógica fora
// da server function para ser testável (account-deletion.test.ts).
//
// O que sai: histórico de partidas, tentativas do Desafio Diário, conquistas,
// estatísticas/XP, perfil e o login (auth.users — o Supabase leva junto as
// identidades de login, como a do Google). O que FICA, por não ter chave
// estrangeira para a conta, está mapeado em docs/exclusao-de-conta.md e é o
// que /privacy e /delete-account dizem — manter os três alinhados.
//
// Ordem fail-closed: qualquer falha interrompe ANTES de apagar o login. Antes
// (até 27/10/2026) o erro de cada etapa era ignorado: daily_attempts e
// user_achievements (sem FK para auth.users) podiam sobrar órfãs com o
// user_id depois de a conta sumir. Repetir é seguro: cada etapa é
// idempotente.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const DELETE_ACCOUNT_FAILED =
  "Não foi possível excluir a conta. Tente novamente em instantes.";

type Step = { table: string; error: { message?: string } | null };

function assertSteps(steps: Step[]) {
  const failed = steps.filter((s) => s.error);
  if (failed.length === 0) return;
  console.error(
    "[deleteAccount] etapa falhou — login preservado para nova tentativa",
    failed.map((s) => `${s.table}: ${s.error?.message ?? "erro"}`),
  );
  throw new Error(DELETE_ACCOUNT_FAILED);
}

export async function deleteAccountData(
  db: SupabaseClient<Database>,
  userId: string,
): Promise<{ ok: true }> {
  // 1) Histórico de partidas
  const history = await db.from("match_history").delete().eq("user_id", userId);
  assertSteps([{ table: "match_history", error: history.error }]);

  // 2) Dados pessoais explícitos
  const [daily, achievements, stats, profile] = await Promise.all([
    db.from("daily_attempts").delete().eq("user_id", userId),
    db.from("user_achievements").delete().eq("user_id", userId),
    db.from("user_stats").delete().eq("user_id", userId),
    db.from("profiles").delete().eq("user_id", userId),
  ]);
  assertSteps([
    { table: "daily_attempts", error: daily.error },
    { table: "user_achievements", error: achievements.error },
    { table: "user_stats", error: stats.error },
    { table: "profiles", error: profile.error },
  ]);

  // 3) Conta de autenticação (por último: sem ela não há nova tentativa)
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) {
    console.error("[deleteAccount] auth.admin.deleteUser failed", error);
    throw new Error(DELETE_ACCOUNT_FAILED);
  }
  return { ok: true };
}
