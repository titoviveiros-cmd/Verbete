// Escala de tempos para salas grandes.
//
// Regra (2026-07-27): até 6 jogadores os tempos originais valem como estão;
// de 7 a 12 jogadores os tempos de LEITURA crescem proporcionalmente (fator
// n/6): votação (mais cédulas) e revelação/placar (mais cards e fileiras).
// O espelho autoritativo desta função vive no servidor (public.phase_secs);
// aqui ela alimenta apenas contagens e barras locais — qualquer divergência
// é corrigida pelo round_phase_ends_at vindo do banco.
export function phaseTimeFactor(activePlayers: number): number {
  return Math.max(1, Math.min(12, activePlayers) / 6);
}

export function scalePhaseSecs(base: number, activePlayers: number): number {
  return Math.round(base * phaseTimeFactor(activePlayers));
}

// Escrita (2026-10-25): cada jogador escreve UMA definição, com 4 ou com 12
// na sala — o tempo NÃO cresce com o nº de jogadores: é a base + 10 s fixos
// (antes, base × n/6: 60 s viravam 120 s com 12). A prorrogação também não
// escala. Espelho do servidor: public.writing_phase_secs.
export const WRITING_BASE_SECS = 60;
export const WRITING_EXTRA_SECS = 10;
export const WRITING_EXTENSION_SECS = [20, 15] as const;

export function writingPhaseSecs(base: number = WRITING_BASE_SECS): number {
  return base + WRITING_EXTRA_SECS;
}

/** Máximo da barra da escrita: tempo da fase ou a prorrogação em curso. */
export function writingTimerMax(activeExtension: number): number {
  if (activeExtension >= 2) return WRITING_EXTENSION_SECS[1];
  if (activeExtension === 1) return WRITING_EXTENSION_SECS[0];
  return writingPhaseSecs();
}

// Coordenador BOT (playtest 2026-10-21): a tela "Coordenador da rodada —
// 🤖 Fulano está escolhendo a palavra…" sumia sem ser lida — o host escolhia
// em ~1 s, ainda sob a cortina. Agora a escolha sai só depois da cortina
// inteira + BOT_COORDINATOR_HOLD_MS (≈2,6–3 s de tela legível em todos os
// navegadores, já que a virada de fase chega a todos juntos). As palavras são
// buscadas em paralelo durante a espera; os demais navegadores só cobrem a
// falta do host bem depois (a RPC aceita só a primeira escolha).
export const BOT_COORDINATOR_HOLD_MS = 2400;
export const BOT_PICK_GUEST_EXTRA_MS = 4000;

export function botPickDelayMs(isHost: boolean, curtainTotalMs: number) {
  const host = curtainTotalMs + BOT_COORDINATOR_HOLD_MS;
  return isHost ? host : host + BOT_PICK_GUEST_EXTRA_MS;
}
