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
