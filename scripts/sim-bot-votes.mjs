// Simulação da política de voto dos bots (playtest 2026-10-22).
// Uso: node scripts/sim-bot-votes.mjs [taxaHumanaNaVerdade] [taxaHumana🧠]
//
// Mesa de 4, 6 rodadas, 100 partidas por cenário (1, 2 e 3 bots), sorteio
// com semente fixa (determinístico). Pontuação idêntica à do motor
// (advance_voting_to_reveal): +3 a quem vota na verdade, +1 por voto no
// próprio blefe, +2 ao coordenador se ninguém achou a verdade; todos votam,
// o coordenador também (sem blefe próprio); bot nunca ganha 🧠 (o gate dos
// bots corta a nota ≥ 50). Humanos: votam na verdade com a taxa medida no
// banco (42,9% em 28 votos, 22/10) e, no resto, num blefe ao acaso.
// "Antes": bot sorteia entre todas as cédulas menos a própria (cliente
// antigo). "Depois": cast_bot_votes — 17,5% na verdade (nunca acima do
// chute às cegas), resto num blefe ao
// acaso que não seja o seu (supabase/migrations/20261022160000).

const HUMAN_TRUTH = Number(process.argv[2] ?? 0.429);
const HUMAN_BRAIN = Number(process.argv[3] ?? 0);
const BOT_TRUTH_AFTER = 0.175;
const MATCHES = 100;
const ROUNDS = 6;
const SEATS = 4;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function play(rand, bots, policy, stats) {
  // assentos embaralhados: quem coordena 2× (6 rodadas, 4 jogadores) varia
  const seats = [...Array(SEATS).keys()]
    .map((p) => ({ p, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.p);
  const isBot = (p) => p < bots;
  const score = Array(SEATS).fill(0);
  for (let r = 0; r < ROUNDS; r++) {
    const coord = seats[r % SEATS];
    const writers = seats.filter((p) => p !== coord);
    // cédulas: "T" (verdade) + o blefe de cada escritor
    for (const w of writers)
      if (!isBot(w) && rand() < HUMAN_BRAIN) score[w] += 3;
    let truthVotes = 0;
    const received = Array(SEATS).fill(0);
    for (const voter of seats) {
      const bluffs = writers.filter((w) => w !== voter);
      let truth;
      if (isBot(voter)) {
        truth =
          policy === "antes"
            ? rand() < 1 / (bluffs.length + 1)
            : rand() < Math.min(BOT_TRUTH_AFTER, 1 / (bluffs.length + 1));
        stats.botVotes++;
        if (truth) stats.botTruth++;
      } else truth = rand() < HUMAN_TRUTH;
      if (truth) {
        truthVotes++;
        score[voter] += 3;
      } else received[bluffs[Math.floor(rand() * bluffs.length)]]++;
    }
    for (const w of writers) score[w] += received[w];
    if (truthVotes === 0) score[coord] += 2;
  }
  return { score, isBot };
}

function scenario(bots, policy) {
  const rand = mulberry32(1000 * bots + (policy === "antes" ? 1 : 2));
  const stats = { botVotes: 0, botTruth: 0 };
  let botPts = 0;
  let humanPts = 0;
  let botFirst = 0;
  let botFirstAlone = 0;
  let botRankSum = 0;
  for (let m = 0; m < MATCHES; m++) {
    const { score, isBot } = play(rand, bots, policy, stats);
    const top = Math.max(...score);
    const leaders = score
      .map((s, p) => (s === top ? p : -1))
      .filter((p) => p >= 0);
    if (leaders.some(isBot)) botFirst++;
    if (leaders.length === 1 && isBot(leaders[0])) botFirstAlone++;
    for (let p = 0; p < SEATS; p++) {
      // posição com empate dividido (1 = primeiro)
      const above = score.filter((s) => s > score[p]).length;
      const tied = score.filter((s) => s === score[p]).length;
      const rank = above + (tied + 1) / 2;
      if (isBot(p)) {
        botPts += score[p];
        botRankSum += rank;
      } else humanPts += score[p];
    }
  }
  return {
    bots,
    policy,
    botTruthPct: (100 * stats.botTruth) / stats.botVotes,
    botPts: botPts / (MATCHES * bots),
    humanPts: humanPts / (MATCHES * (SEATS - bots)),
    botRank: botRankSum / (MATCHES * bots),
    botFirstPct: botFirst,
    botFirstAlonePct: botFirstAlone,
    fairPct: (100 * bots) / SEATS,
  };
}

console.log(
  `mesa de ${SEATS}, ${ROUNDS} rodadas, ${MATCHES} partidas por cenário; humano na verdade = ${(HUMAN_TRUTH * 100).toFixed(1)}%, 🧠 humano = ${(HUMAN_BRAIN * 100).toFixed(0)}%`,
);
console.log(
  "| bots | política | votos de bot na verdade | pontos por bot | pontos por humano | posição média do bot | bot em 1º (com empate) | bot em 1º sozinho | parte justa |",
);
console.log("|---|---|---|---|---|---|---|---|---|");
for (const bots of [1, 2, 3])
  for (const policy of ["antes", "depois"]) {
    const s = scenario(bots, policy);
    console.log(
      `| ${bots} | ${policy} | ${s.botTruthPct.toFixed(1)}% | ${s.botPts.toFixed(2)} | ${s.humanPts.toFixed(2)} | ${s.botRank.toFixed(2)} | ${s.botFirstPct}% | ${s.botFirstAlonePct}% | ${s.fairPct.toFixed(0)}% |`,
    );
  }
