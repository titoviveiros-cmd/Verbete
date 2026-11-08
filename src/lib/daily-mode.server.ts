// D1: modo do Diário (app_config.daily_mode) lido no servidor, SEM cache —
// a troca de modo vale no envio seguinte. Erro ou função ausente (migration
// D1 ainda não aplicada) = 'juiz', o fluxo atual: o Worker novo pode subir
// antes ou depois da migration sem mudar nada para o jogador.
import { parseDailyMode, type DailyMode } from "./daily-choice";

type RpcClient = {
  rpc: (fn: "daily_mode") => PromiseLike<{ data: unknown; error: unknown }>;
};

export async function loadDailyMode(db: RpcClient): Promise<DailyMode> {
  try {
    const { data, error } = await db.rpc("daily_mode");
    if (error) return "juiz";
    return parseDailyMode(data);
  } catch {
    return "juiz";
  }
}
