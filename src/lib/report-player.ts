// Denúncia de JOGADOR — apelido ou comportamento (Google Play, política de
// conteúdo gerado por usuários). O apelido é texto livre do jogador e o
// filtro de palavras roda só no cliente (o servidor apenas corta em 24
// caracteres): sem esta via, um apelido ofensivo não tinha como ser
// denunciado — só as definições (report-definition.ts).
//
// Reaproveita a fila de reports e o painel /admin/reports SEM migration:
// definition_id nulo, o "texto" denunciado é a foto do apelido no momento da
// denúncia e o motivo leva o prefixo "player_". Alvo, sala e apelido vêm do
// BANCO pelo id do jogador — o cliente só escolhe quem e por quê. Gravar o
// alvo resolvido é seguro porque reports não é legível pelo cliente
// (migration 20261023190000_reports_server_only).
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { PLAYER_REASON_PREFIX } from "@/lib/report-player-reasons";

// Campos a mais do cliente (texto, sala, autor) são descartados. Mesmas
// chaves de PLAYER_REPORT_REASONS (o teste confere).
export const PlayerReportInput = z.object({
  playerId: z.string().trim().min(1).max(64),
  reason: z
    .enum(["nickname", "behavior", "impersonation", "other"])
    .default("nickname"),
});
export type PlayerReportInputData = z.infer<typeof PlayerReportInput>;

const FAILED = "Não foi possível enviar a denúncia.";

export async function filePlayerReport(
  db: SupabaseClient<Database>,
  reporterUserId: string,
  input: PlayerReportInputData,
): Promise<{ ok: true }> {
  const { data: target, error: targetErr } = await db
    .from("players")
    .select("id, room_id, nickname, avatar, user_id, is_bot")
    .eq("id", input.playerId)
    .maybeSingle();
  if (targetErr) {
    console.error("[reportPlayer] player lookup failed", targetErr);
    throw new Error(FAILED);
  }
  if (!target) throw new Error("Jogador não encontrado.");
  // Bots têm nome do sistema (bot-names.ts): não há conteúdo de jogador.
  if (target.is_bot) throw new Error("Bots não podem ser denunciados.");
  if (target.user_id && target.user_id === reporterUserId)
    throw new Error("Você não pode denunciar a si mesmo.");

  const [reporter, existing, room] = await Promise.all([
    // Só quem está (ou esteve) na MESMA sala denuncia: barra denúncia em
    // massa pela API contra ids de outras salas.
    db
      .from("players")
      .select("id")
      .eq("room_id", target.room_id)
      .eq("user_id", reporterUserId)
      .limit(1),
    // Anti-spam: 1 denúncia de jogador por denunciante + alvo (limit, não
    // maybeSingle: duplicatas antigas não podem virar erro e liberar outra).
    db
      .from("reports")
      .select("id")
      .eq("reporter_user_id", reporterUserId)
      .eq("offender_player_id", target.id)
      .is("definition_id", null)
      .limit(1),
    db
      .from("rooms")
      .select("code, current_round")
      .eq("id", target.room_id)
      .maybeSingle(),
  ]);
  if (reporter.error || existing.error) {
    console.error(
      "[reportPlayer] reporter/duplicate check failed",
      reporter.error ?? existing.error,
    );
    throw new Error(FAILED);
  }
  if (room.error)
    console.error("[reportPlayer] room lookup failed", room.error);
  if ((reporter.data ?? []).length === 0)
    throw new Error("Só quem está na sala pode denunciar um jogador.");
  if ((existing.data ?? []).length > 0) return { ok: true };

  const snapshot = `Apelido: ${target.nickname || "—"} · avatar: ${target.avatar || "—"}`;
  const { error } = await db.from("reports").insert({
    definition_id: null,
    definition_text: snapshot.slice(0, 500),
    room_id: target.room_id,
    room_code: room.data?.code ?? null,
    round: room.data?.current_round ?? null,
    offender_player_id: target.id,
    offender_nickname: target.nickname ?? null,
    offender_user_id: target.user_id ?? null,
    reporter_user_id: reporterUserId,
    reason: PLAYER_REASON_PREFIX + input.reason,
  });
  if (error) {
    console.error("[reportPlayer] insert failed", error);
    throw new Error(FAILED);
  }
  return { ok: true };
}
