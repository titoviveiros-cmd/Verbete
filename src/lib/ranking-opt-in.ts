// B6 — ECA Digital (Lei 15.211/2025 arts. 7º e 8º IV): o jogador só aparece
// nos rankings públicos (Top 50 e Ranking de hoje) se ATIVAR. Padrão desligado
// para todos; desligar vale a qualquer momento e não pede nada.
// A regra de verdade está no banco (migration 20261111154500_ranking_opt_in:
// get_ranking_top, get_daily_leaderboard e a leitura de profiles filtram pela
// coluna). Aqui só se lê e grava a escolha do próprio titular.
import { supabase } from "@/integrations/supabase/client";
import { assertTermsAccepted } from "@/lib/terms-consent";

/** Texto único da escolha (Perfil e Ranking mostram o mesmo). */
export const RANKING_OPT_IN_COPY = {
  label: "Aparecer no ranking público",
  on: "Seu nome, avatar e pontos aparecem para outros jogadores no Ranking e no Ranking de hoje. Desligue quando quiser.",
  off: "Desligado: ninguém vê seu nome nos rankings. Só você vê a sua posição.",
} as const;

/** Escolha atual do titular; null = não deu para ler (sem perfil, sem rede). */
export async function fetchRankingOptIn(
  userId: string,
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("ranking_opt_in")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data.ranking_opt_in === true;
}

/**
 * Grava a escolha. Ativar põe o nome à vista de terceiros (conteúdo do
 * usuário): exige o aceite dos Termos da sessão em vigor, como editar o nome.
 * Desativar nunca exige nada.
 */
export async function setRankingOptIn(
  userId: string,
  value: boolean,
): Promise<void> {
  if (value) await assertTermsAccepted();
  const { error } = await supabase
    .from("profiles")
    .update({ ranking_opt_in: value })
    .eq("user_id", userId);
  if (error) throw new Error(error.message || "não foi possível salvar");
}
