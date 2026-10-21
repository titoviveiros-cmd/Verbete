// Escala de tempos para salas grandes.
//
// Regra (2026-07-27): até 6 jogadores os tempos originais valem como estão;
// de 7 a 12 jogadores TODOS os tempos de fase crescem proporcionalmente
// (fator n/6) para dar tempo de ler todas as cédulas da votação.
// O espelho autoritativo desta função vive no servidor (public.phase_secs);
// aqui ela alimenta apenas contagens e barras locais — qualquer divergência
// é corrigida pelo round_phase_ends_at vindo do banco.
export function phaseTimeFactor(activePlayers: number): number {
  return Math.max(1, Math.min(12, activePlayers) / 6);
}

export function scalePhaseSecs(base: number, activePlayers: number): number {
  return Math.round(base * phaseTimeFactor(activePlayers));
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
