// Regras de mesa (playtest 2026-10-20): a partida só começa com 4 ou mais
// participantes ATIVOS (humanos + bots). O servidor (start_game) garante o
// mesmo mínimo — aqui o client só evita o clique inútil e explica o porquê.
export const MIN_PLAYERS = 4;

type Seat = { kicked_at?: string | null };

/** Participantes que contam para a mesa (expulsos não contam). */
export const activeCount = (players: readonly Seat[]) =>
  players.filter((p) => !p.kicked_at).length;

export const canStartGame = (players: readonly Seat[]) =>
  activeCount(players) >= MIN_PLAYERS;

/** Quantos bots faltam para completar a mesa mínima. */
export const botsToMinimum = (players: readonly Seat[]) =>
  Math.max(0, MIN_PLAYERS - activeCount(players));

export function startButtonLabel(o: {
  count: number;
  starting: boolean;
  teamsOK: boolean;
  /** O servidor acabou de recusar por mesa incompleta (min_players). */
  refused?: boolean;
}): string {
  if (o.starting) return "Iniciando…";
  if (o.count < MIN_PLAYERS)
    return `Mín. ${MIN_PLAYERS} jogadores (${o.count}/${MIN_PLAYERS})`;
  if (o.refused) return "Os bots ainda estão entrando — toque de novo";
  if (!o.teamsOK) return "⚠️ Atribua todos a um time";
  return "🚀 Começar!";
}
