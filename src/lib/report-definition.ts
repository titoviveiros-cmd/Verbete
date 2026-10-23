// Denúncia de definição (moderação do conteúdo dos jogadores — exigida pelas
// lojas). Autor, texto e sala vêm do BANCO pelo id da cédula, nunca do
// cliente: na votação as cédulas chegam sem autor (player_id "", migration
// 20260721100000_fase1_ballot_secure) e o servidor recusava TODA denúncia ali
// (offenderPlayerId vazio) — além de o cliente poder forjar autor e texto.
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// Campos a mais (clientes antigos mandavam autor/texto/sala) são descartados.
export const ReportInput = z.object({
  definitionId: z.string().uuid(),
  reason: z
    .enum(["inappropriate", "spam", "harassment", "other"])
    .default("inappropriate"),
});
export type ReportInputData = z.infer<typeof ReportInput>;

const FAILED = "Não foi possível enviar a denúncia.";

export async function fileReport(
  db: SupabaseClient<Database>,
  reporterUserId: string,
  input: ReportInputData,
): Promise<{ ok: true }> {
  const { data: def, error: defErr } = await db
    .from("definitions")
    .select("id, room_id, round, player_id, text, is_truth")
    .eq("id", input.definitionId)
    .maybeSingle();
  if (defErr) {
    console.error("[reportDefinition] definition lookup failed", defErr);
    throw new Error(FAILED);
  }
  if (!def) throw new Error("Definição não encontrada.");

  // As mesmas consultas para toda cédula, inclusive a verdadeira.
  const [existing, room, offender] = await Promise.all([
    // Anti-spam: 1 denúncia por usuário+definição
    db
      .from("reports")
      .select("id")
      .eq("reporter_user_id", reporterUserId)
      .eq("definition_id", def.id)
      .maybeSingle(),
    db.from("rooms").select("code").eq("id", def.room_id).maybeSingle(),
    db
      .from("players")
      .select("nickname, user_id")
      .eq("id", def.player_id)
      .eq("room_id", def.room_id)
      .maybeSingle(),
  ]);

  // A definição verdadeira (do dicionário) não é denunciável, mas a resposta
  // é IDÊNTICA à de uma denúncia registrada — senão denunciar viraria um
  // jeito de achar a resposta certa durante a votação.
  if (def.is_truth || def.player_id === "__truth__" || existing.data)
    return { ok: true };

  const { error } = await db.from("reports").insert({
    definition_id: def.id,
    definition_text: def.text,
    room_id: def.room_id,
    room_code: room.data?.code ?? null,
    round: def.round,
    offender_player_id: def.player_id,
    offender_nickname: offender.data?.nickname ?? null,
    offender_user_id: offender.data?.user_id ?? null,
    reporter_user_id: reporterUserId,
    reason: input.reason,
  });
  if (error) {
    console.error("[reportDefinition] insert failed", error);
    throw new Error(FAILED);
  }
  return { ok: true };
}
