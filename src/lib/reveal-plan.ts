// Plano da revelação "verdade primeiro": VERDADE → QUEM ACERTOU → BLEFES
// (do mais fraco ao que mais enganou) → BLEFE DA RODADA → leitura → placar.
//
// Tudo aqui é DETERMINÍSTICO — depende só dos dados da rodada (definições,
// votos, letras, número da rodada) e nunca de Math.random/relógio — para que
// host e convidados vejam a MESMA sequência, com as mesmas frases. Nada aqui
// toca pontuação: a tela só reapresenta números que o servidor já calculou.

export type RevealStepKind =
  "intro" | "truth" | "correct" | "bridge" | "bluff" | "best" | "hold";

export type RevealStep = {
  kind: RevealStepKind;
  /** ms desde o início da revelação */
  at: number;
  /** índice do blefe (ordem de revelação) quando kind === "bluff" */
  index?: number;
};

// Ritmo (ms). A verdade aparece quase de imediato; os blefes que enganaram
// alguém ganham mais tempo que os que passaram batido.
export const INTRO_MS = 550;
export const TRUTH_MS = 1000;
export const CORRECT_MS = 900;
export const BRIDGE_MS = 600;
export const BEST_MS = 1300;
/** Teto da sequência de blefes — salas cheias aceleram em vez de alongar. */
export const BLUFFS_BUDGET_MS = 7000;
/** Leitura final antes do placar (segundos, escalada pelo tamanho da sala). */
export const HOLD_BASE_SECS = 8;

type BluffLike = { id: string; letter?: string | null };

/** Ordem de revelação: menos votados primeiro; o que mais enganou por último. Empate: letra, depois id. */
export function orderBluffs<T extends BluffLike>(
  bluffs: T[],
  votesOf: (id: string) => number,
): T[] {
  return [...bluffs].sort((a, b) => {
    const dv = votesOf(a.id) - votesOf(b.id);
    if (dv !== 0) return dv;
    const dl = (a.letter ?? "~").localeCompare(b.letter ?? "~");
    if (dl !== 0) return dl;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Blefe da rodada (só reconhecimento social: não dá ponto, XP nem bônus):
 * o último da ordem de revelação — o mais votado; no empate, o que fecha a
 * sequência. Nenhum blefe com voto → não há blefe da rodada.
 */
export function bestBluffId<T extends BluffLike>(
  ordered: T[],
  votesOf: (id: string) => number,
): string | null {
  const last = ordered[ordered.length - 1];
  return last && votesOf(last.id) > 0 ? last.id : null;
}

/** Duração de cada blefe, já com a aceleração das salas cheias. */
export function bluffDurations(votes: number[]): number[] {
  const base = votes.map((v) =>
    v === 0 ? 550 : Math.min(1500, 1000 + 120 * (v - 1)),
  );
  const sum = base.reduce((a, b) => a + b, 0);
  if (sum <= BLUFFS_BUDGET_MS) return base;
  const f = BLUFFS_BUDGET_MS / sum;
  return votes.map((v, i) =>
    Math.max(v === 0 ? 300 : 650, Math.round(base[i]! * f)),
  );
}

/** Linha do tempo completa (passo "hold" = início da leitura final + contagem). */
export function planReveal(
  bluffVotes: number[],
  hasBest: boolean,
): {
  steps: RevealStep[];
  holdAt: number;
} {
  const steps: RevealStep[] = [{ kind: "intro", at: 0 }];
  let t = INTRO_MS;
  steps.push({ kind: "truth", at: t });
  t += TRUTH_MS;
  steps.push({ kind: "correct", at: t });
  t += CORRECT_MS;
  if (bluffVotes.length > 0) {
    steps.push({ kind: "bridge", at: t });
    t += BRIDGE_MS;
    const d = bluffDurations(bluffVotes);
    for (let i = 0; i < bluffVotes.length; i++) {
      steps.push({ kind: "bluff", at: t, index: i });
      t += d[i]!;
    }
    if (hasBest) {
      steps.push({ kind: "best", at: t });
      t += BEST_MS;
    }
  }
  steps.push({ kind: "hold", at: t });
  return { steps, holdAt: t };
}

// ---- Microcopy -------------------------------------------------------------

const pick = (options: string[], seed: number) =>
  options[Math.abs(seed) % options.length]!;

function seedOf(round: number, letter?: string | null) {
  return round * 31 + (letter ? letter.charCodeAt(0) : 0);
}

/**
 * Frase curta para o blefe. `maxPossible` = quantos poderiam ter caído
 * (votantes da rodada menos o autor, que não vota em si).
 */
export function bluffQuip(
  votes: number,
  maxPossible: number,
  round: number,
  letter?: string | null,
): string {
  const s = seedOf(round, letter);
  if (votes <= 0)
    return pick(["ninguém caiu nessa", "passou batido", "não colou"], s);
  if (maxPossible >= 2 && votes >= maxPossible)
    return pick(["enganou todo mundo!", "golpe perfeito"], s);
  if (maxPossible >= 3 && votes === maxPossible - 1)
    return pick(["quase perfeito", "por um triz, todos"], s);
  if (votes === 1)
    return pick(["pegou um", "fez uma vítima", "um caiu direitinho"], s);
  return pick(["essa convenceu", "colou bonito", `${votes} caíram`], s);
}

/** Título do bloco "quem acertou". */
export function correctHeadline(
  hits: number,
  voters: number,
  iHit: boolean,
): string {
  if (hits === 0) return "Ninguém acertou! 😱";
  if (voters > 1 && hits >= voters) return "Todo mundo acertou! 🎯";
  if (iHit) return "Você acertou! 🎯";
  return hits === 1 ? "🎯 Só um acertou" : "🎯 Acertaram";
}
