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

/**
 * D1 (modo escolha): só a posição escolhida (0–3). `.strict()` REJEITA campos
 * extras — em especial `timeSeconds`: o tempo do modo escolha é medido no
 * servidor (início → fim), nunca informado pelo cliente.
 */
export const choiceInput = z
  .object({
    pos: z.number().int().min(0).max(3),
    /** hora das alternativas que o jogador viu (ISO); o servidor confere */
    hour: z.string().datetime(),
  })
  .strict();
