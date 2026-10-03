// Controle remoto mínimo do app instalado (RC-01): versão mínima do APK e
// modo manutenção, lidos de get_client_config() (chaves client.* de
// app_config). Falha ABERTA: sem resposta do servidor, nada é bloqueado.
import { supabase } from "@/integrations/supabase/client";

export type ClientConfig = Partial<
  Record<
    "min_native_build" | "maintenance" | "maintenance_message" | "store_url",
    string
  >
>;

export type Gate =
  | { kind: "ok" }
  | { kind: "update"; storeUrl: string }
  | { kind: "maintenance"; message: string };

export const DEFAULT_STORE_URL =
  "https://play.google.com/store/apps/details?id=app.verbete.game";
const DEFAULT_MAINTENANCE =
  "O Verbete está em manutenção rapidinho. Volte em alguns minutos!";

/** versionCode do APK (injetado no build nativo a partir do build.gradle). */
export function nativeBuildNumber(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function evaluateGate(
  cfg: ClientConfig | null,
  env: { native: boolean; nativeBuild: number | null },
): Gate {
  if (!cfg) return { kind: "ok" };
  if (cfg.maintenance?.trim().toLowerCase() === "on") {
    return {
      kind: "maintenance",
      message: cfg.maintenance_message?.trim() || DEFAULT_MAINTENANCE,
    };
  }
  const min = Number(cfg.min_native_build);
  if (
    env.native &&
    env.nativeBuild !== null &&
    Number.isInteger(min) &&
    min > env.nativeBuild
  ) {
    const url = cfg.store_url?.trim() ?? "";
    return {
      kind: "update",
      storeUrl: /^https:\/\//.test(url) ? url : DEFAULT_STORE_URL,
    };
  }
  return { kind: "ok" };
}

export async function fetchClientConfig(
  timeoutMs = 6000,
): Promise<ClientConfig | null> {
  try {
    const res = await Promise.race([
      supabase.rpc("get_client_config"),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      ),
    ]);
    if (!res || res.error || !res.data || typeof res.data !== "object")
      return null;
    return res.data as ClientConfig;
  } catch {
    return null;
  }
}
