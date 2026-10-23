// Histórico do placar como UMA unidade consistente (playtest 2026-10-22: num
// aparelho o placar saiu só com posição/avatar/nome/total — as linhas de
// "como cada um pontuou" não vieram, e na rodada seguinte voltaram sozinhas).
// As 5 leituras não tinham prazo, erro tratado nem nova tentativa: com uma
// delas presa (o aparelho perdeu o canal realtime 2× nesse playtest) o
// detalhamento não chegava naquela rodada; com uma falhando, o placar montava
// linhas FALSAS ("Ainda sem pontos"). Agora as 5 vêm juntas, cada tentativa
// tem prazo, e só vale o retrato que traz as rodadas pontuadas inteiras.
import type { supabase as SupabaseClient } from "@/integrations/supabase/client";
import type { Definition, Vote } from "@/lib/room";

export type ScoreHistory = {
  defs: Definition[];
  votes: Vote[];
  rounds: { round: number; coordinator_id: string; scored_at: string }[];
  nearTruthIds: Set<string>;
  extensions: { player_id: string; round: number; attempt: number }[];
};

/** Tentativa imediata → +400 ms → +1000 ms; depois disso, só com gatilho. */
export const HISTORY_RETRY_DELAYS_MS = [400, 1000] as const;
/** Prazo de cada tentativa: uma leitura presa não segura o placar. */
export const HISTORY_ATTEMPT_TIMEOUT_MS = 3500;

type Res = { data: unknown; error: unknown };
export type RawScoreHistory = {
  defs: Res;
  votes: Res;
  rounds: Res;
  reveal: Res;
  exts: Res;
};

/** As 5 leituras do placar, juntas, todas canceláveis pelo mesmo sinal. */
export async function fetchScoreHistory(
  client: typeof SupabaseClient,
  roomId: string,
  signal: AbortSignal,
): Promise<RawScoreHistory> {
  const [defs, votes, rounds, reveal, exts] = await Promise.all([
    // S1: leitura direta de definitions foi revogada — a RPC devolve as
    // rodadas já reveladas (a corrente só a partir do reveal).
    client
      .rpc("get_room_definitions", { p_room_id: roomId })
      .abortSignal(signal),
    client.from("votes").select("*").eq("room_id", roomId).abortSignal(signal),
    client
      .from("rounds")
      .select("round,coordinator_id,scored_at")
      .eq("room_id", roomId)
      .abortSignal(signal),
    client.rpc("get_room_reveal", { p_room_id: roomId }).abortSignal(signal),
    client
      .from("round_extensions")
      .select("player_id,round,attempt")
      .eq("room_id", roomId)
      .abortSignal(signal),
  ]);
  return { defs, votes, rounds, reveal, exts };
}

/**
 * Retrato consistente ou o motivo para reler. Nada de montar detalhamento
 * com pedaço: qualquer leitura com erro, a revelação indisponível, a rodada
 * corrente ainda sem pontuação (`requireRound`) ou uma rodada pontuada sem as
 * definições dela = ainda carregando.
 */
export function buildScoreHistory(
  raw: RawScoreHistory,
  opts: { round: number; requireRound: boolean },
): { ok: true; history: ScoreHistory } | { ok: false; reason: string } {
  for (const [name, r] of Object.entries(raw))
    if (r.error) return { ok: false, reason: `erro:${name}` };
  const defs = raw.defs.data;
  const votes = raw.votes.data;
  const rounds = raw.rounds.data;
  const exts = raw.exts.data;
  if (
    !Array.isArray(defs) ||
    !Array.isArray(votes) ||
    !Array.isArray(rounds) ||
    !Array.isArray(exts)
  )
    return { ok: false, reason: "sem_dados" };
  const reveal = raw.reveal.data as {
    available?: boolean;
    near_truth_ids?: unknown;
  } | null;
  if (!reveal?.available || !Array.isArray(reveal.near_truth_ids))
    return { ok: false, reason: "revelacao_indisponivel" };
  const scored = new Set(
    (rounds as { round: number }[]).map((r) => Number(r.round)),
  );
  if (opts.requireRound && !scored.has(opts.round))
    return { ok: false, reason: `rodada_${opts.round}_sem_pontuacao` };
  for (const r of scored) {
    const hasTruth = (defs as Definition[]).some(
      (d) => d.round === r && d.player_id === "__truth__",
    );
    if (!hasTruth) return { ok: false, reason: `rodada_${r}_sem_definicoes` };
  }
  return {
    ok: true,
    history: {
      defs: defs as Definition[],
      votes: votes as Vote[],
      rounds: rounds as ScoreHistory["rounds"],
      nearTruthIds: new Set(reveal.near_truth_ids as string[]),
      extensions: exts as ScoreHistory["extensions"],
    },
  };
}
