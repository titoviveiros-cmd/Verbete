// D1: modo do Diário (app_config.daily_mode) lido no servidor, SEM cache —
// a troca de modo vale no envio seguinte. Só a função AUSENTE (migration D1
// ainda não aplicada: PGRST202 / 42883) vira 'juiz', o fluxo atual. Qualquer
// outra falha LANÇA (Red Team A5): com o modo escolha ligado, uma falha
// passageira não pode reabrir o caminho do juiz; quem chama recusa sem gastar.
import { parseDailyMode, type DailyMode } from "./daily-choice";

type RpcClient = {
  rpc: (fn: "daily_mode") => PromiseLike<{ data: unknown; error: unknown }>;
};

const FUNCAO_AUSENTE = new Set(["PGRST202", "42883"]);

export async function loadDailyMode(db: RpcClient): Promise<DailyMode> {
  const { data, error } = await db.rpc("daily_mode");
  if (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (FUNCAO_AUSENTE.has(code)) return "juiz";
    throw new Error(`daily_mode ${code || "?"}`);
  }
  return parseDailyMode(data);
}
