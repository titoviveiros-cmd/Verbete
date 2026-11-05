import { z } from "zod";

/**
 * Entrada do envio do Diário. NÃO tem identidade do jogador: o usuário vem
 * SEMPRE da sessão validada (requireSupabaseAuth). Campos extras enviados
 * pelo cliente (ex.: user_id forjado) são descartados pelo zod.
 */
export const submitInput = z.object({
  guess: z.string().min(1).max(200),
  timeSeconds: z.number().int().min(0).max(600),
});
