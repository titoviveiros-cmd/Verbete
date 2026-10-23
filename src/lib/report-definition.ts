// Denúncia de definição (moderação do conteúdo dos jogadores — exigida pelas
// lojas). Autor, texto e sala vêm do BANCO pelo id da cédula, nunca do
// cliente: na votação as cédulas chegam sem autor (player_id "", migration
// 20260721100000_fase1_ballot_secure) e o servidor recusava TODA denúncia ali
// (offenderPlayerId vazio) — além de o cliente poder forjar autor e texto.
// Gravar o autor resolvido só é seguro porque reports NÃO é legível pelo
// cliente (migration 20261023190000_reports_server_only — aplicar antes).
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
const TRUTH_NOTE =
  "Definição verdadeira (do dicionário) — descartada automaticamente.";

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

  // Toda cédula — inclusive a verdadeira — passa pelas MESMAS consultas e
  // pela MESMA gravação, com a MESMA resposta: nem o conteúdo nem o tempo da
  // denúncia podem revelar a resposta certa durante a votação.
  const [existing, room, offender] = await Promise.all([
    // Anti-spam: 1 denúncia por usuário+definição (limit, não maybeSingle:
    // duplicatas antigas não podem virar erro e liberar outra gravação)
    db
      .from("reports")
      .select("id")
      .eq("reporter_user_id", reporterUserId)
      .eq("definition_id", def.id)
      .limit(1),
    db.from("rooms").select("code").eq("id", def.room_id).maybeSingle(),
    db
      .from("players")
      .select("nickname, user_id")
      .eq("id", def.player_id)
      .maybeSingle(),
  ]);
  if (existing.error) {
    console.error("[reportDefinition] duplicate check failed", existing.error);
    throw new Error(FAILED);
  }
  if (room.error || offender.error)
    console.error(
      "[reportDefinition] room/offender lookup failed",
      room.error ?? offender.error,
    );
  if (existing.data.length > 0) return { ok: true };

  // A verdadeira não é denunciável: entra já descartada, fora da fila do
  // painel (listPendingReports só lista "pending").
  const truth = def.is_truth || def.player_id === "__truth__";
  const { error } = await db.from("reports").insert({
    definition_id: def.id,
    definition_text: (def.text || "—").slice(0, 500),
    room_id: def.room_id,
    room_code: room.data?.code ?? null,
    round: def.round,
    offender_player_id: def.player_id,
    offender_nickname: offender.data?.nickname ?? null,
    offender_user_id: offender.data?.user_id ?? null,
    reporter_user_id: reporterUserId,
    reason: input.reason,
    ...(truth
      ? {
          status: "dismissed",
          resolution_note: TRUTH_NOTE,
          resolved_at: new Date().toISOString(),
        }
      : {}),
  });
  if (error) {
    console.error("[reportDefinition] insert failed", error);
    throw new Error(FAILED);
  }
  return { ok: true };
}
