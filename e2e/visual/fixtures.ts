// Partida fictícia, coerente de ponta a ponta, para os testes visuais.
// Três rodadas jogadas; os placares batem com os votos (+3 verdade, +1 por
// voto no próprio blefe, +3 🧠 quase-verdade) para o detalhamento do Placar
// e do Pódio fazer sentido na captura. Textos em minúsculas e sem acento,
// como o servidor guarda.
import type { Json, MockBackend } from "./supabase-mock";

export const ROOM_ID = "6f2c1b0e-3d4a-4c5b-9e8f-1a2b3c4d5e6f";
export const ROOM_CODE = "4827";
export const ME = "p_bia01";
export const USER_ID = "00000000-0000-4000-8000-00000000b1a0";

type P = {
  id: string;
  nickname: string;
  avatar: string;
  color: string;
  is_bot?: boolean;
};
const PEOPLE: P[] = [
  { id: ME, nickname: "Bia", avatar: "🦊", color: "#FF5C8A" },
  { id: "p_ze004", nickname: "Zé", avatar: "🐸", color: "#06D6A0" },
  { id: "p_nina5", nickname: "Nina", avatar: "🦄", color: "#A155F0" },
  { id: "p_lara3", nickname: "Lara", avatar: "🐼", color: "#22D3EE" },
  {
    id: "bot_tio",
    nickname: "TioBlefe",
    avatar: "🐙",
    color: "#F58A07",
    is_bot: true,
  },
  { id: "p_dudu2", nickname: "Dudu", avatar: "🐻", color: "#FFD166" },
];
const [BIA, ZE, NINA, LARA, TIO, DUDU] = PEOPLE.map((p) => p.id) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

const AFTER_R2: Record<string, number> = {
  [BIA]: 8,
  [ZE]: 7,
  [NINA]: 2,
  [LARA]: 5,
  [TIO]: 0,
  [DUDU]: 1,
};
const AFTER_R3: Record<string, number> = {
  [BIA]: 13,
  [ZE]: 10,
  [NINA]: 6,
  [LARA]: 5,
  [TIO]: 3,
  [DUDU]: 1,
};

// Apelidos no limite do campo (14 caracteres) para medir cards e linhas — com
// espaço e o pior caso de largura (14 "W").
export const LONG_NAMES: Record<string, string> = {
  [BIA]: "Beatriz Helena",
  [ZE]: "Joaquim Felipe",
  [NINA]: "Ana Luiza Rosa",
  [LARA]: "Larissa Cabral",
  [TIO]: "TioBlefeDoBolo",
  [DUDU]: "WWWWWWWWWWWWWW",
};

function players(
  scores: Record<string, number> | null,
  ids = PEOPLE.map((p) => p.id),
  longNames = false,
) {
  return PEOPLE.filter((p) => ids.includes(p.id)).map((p, i) => ({
    id: p.id,
    room_id: ROOM_ID,
    nickname: longNames ? (LONG_NAMES[p.id] ?? p.nickname) : p.nickname,
    avatar: p.avatar,
    color: p.color,
    score: scores ? (scores[p.id] ?? 0) : 0,
    is_bot: !!p.is_bot,
    is_connected: true,
    coordinator_count: 0,
    joined_at: new Date(Date.UTC(2026, 9, 18, 15, 0, i)).toISOString(),
    team_id: null,
    writing_extensions: 0,
    voting_extensions: 0,
    kicked_at: null,
  }));
}

export const WORD = {
  id: "11111111-2222-4333-8444-555555555555",
  word: "rapapé",
  category: "comportamento",
  rarity: 3,
  nivel: "medio",
  classe: "substantivo masculino",
  pronuncia: "ra-pa-pé",
};

// Definições das 3 rodadas (id, rodada, autor, texto, letra).
type D = {
  id: string;
  round: number;
  player_id: string;
  text: string;
  letter: string;
};
const d = (n: number) =>
  `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEFS: D[] = [
  // Rodada 1 — coordenadora Bia
  {
    id: d(101),
    round: 1,
    player_id: "__truth__",
    text: "planta rasteira de flores amarelas",
    letter: "C",
  },
  {
    id: d(102),
    round: 1,
    player_id: DUDU,
    text: "barulho de chuva forte no telhado",
    letter: "A",
  },
  {
    id: d(103),
    round: 1,
    player_id: LARA,
    text: "peixe pequeno de agua doce",
    letter: "E",
  },
  {
    id: d(104),
    round: 1,
    player_id: ZE,
    text: "chapeu de palha dos vaqueiros",
    letter: "B",
  },
  {
    id: d(105),
    round: 1,
    player_id: NINA,
    text: "cesto de vime para carregar frutas",
    letter: "F",
  },
  {
    id: d(106),
    round: 1,
    player_id: TIO,
    text: "danca de roda do interior paulista",
    letter: "D",
  },
  // Rodada 2 — coordenador Dudu
  {
    id: d(201),
    round: 2,
    player_id: "__truth__",
    text: "pessoa que fala pelos cotovelos",
    letter: "D",
  },
  {
    id: d(202),
    round: 2,
    player_id: BIA,
    text: "doce de abobora com cravo",
    letter: "A",
  },
  {
    id: d(203),
    round: 2,
    player_id: LARA,
    text: "ferramenta de sapateiro",
    letter: "F",
  },
  {
    id: d(204),
    round: 2,
    player_id: ZE,
    text: "quem conversa demais sem parar",
    letter: "B",
  },
  {
    id: d(205),
    round: 2,
    player_id: NINA,
    text: "nuvem baixa de fim de tarde",
    letter: "E",
  },
  {
    id: d(206),
    round: 2,
    player_id: TIO,
    text: "moeda antiga de cobre",
    letter: "C",
  },
  // Rodada 3 — coordenador Zé; palavra "rapapé"
  {
    id: d(301),
    round: 3,
    player_id: "__truth__",
    text: "cumprimento exagerado, cheio de mesuras; bajulacao",
    letter: "B",
  },
  {
    id: d(302),
    round: 3,
    player_id: LARA,
    text: "doce de rapadura ralada com gengibre e coco queimado",
    letter: "A",
  },
  {
    id: d(303),
    round: 3,
    player_id: BIA,
    text: "pequeno tambor de couro usado nas festas juninas do sertao",
    letter: "C",
  },
  {
    id: d(304),
    round: 3,
    player_id: TIO,
    text: "tecido grosso usado antigamente nas velas dos barcos",
    letter: "D",
  },
  {
    id: d(305),
    round: 3,
    player_id: NINA,
    text: "elogio cheio de reverencias para agradar alguem importante",
    letter: "E",
  },
  {
    id: d(306),
    round: 3,
    player_id: DUDU,
    text: "passo de danca em que se bate o pe tres vezes no chao",
    letter: "F",
  },
];
// Votos (rodada, eleitor → definição). Batem com AFTER_R2/AFTER_R3.
const VOTES: Array<[number, string, string]> = [
  [1, BIA, d(101)],
  [1, DUDU, d(105)],
  [1, LARA, d(101)],
  [1, ZE, d(102)],
  [1, NINA, d(103)],
  [1, TIO, d(103)],
  [2, BIA, d(201)],
  [2, DUDU, d(202)],
  [2, LARA, d(204)],
  [2, ZE, d(201)],
  [2, NINA, d(202)],
  [2, TIO, d(205)],
  [3, BIA, d(301)],
  [3, DUDU, d(303)],
  [3, LARA, d(305)],
  [3, ZE, d(301)],
  [3, NINA, d(303)],
  [3, TIO, d(301)],
];
const NEAR_TRUTH = [d(204), d(305)];
// Rodada 3 (a da revelação/placar simulados): a verdade e o blefe 🧠.
export const R3_TRUTH = DEFS.find(
  (x) => x.round === 3 && x.player_id === "__truth__",
)!;
export const R3_NEAR = DEFS.find((x) => x.id === d(305))!;
// room_id como no banco (NOT NULL): o simulador aplica o filtro room_id=eq.
const ROUNDS = [
  {
    room_id: ROOM_ID,
    round: 1,
    coordinator_id: BIA,
    scored_at: "2026-10-18T15:04:00Z",
  },
  {
    room_id: ROOM_ID,
    round: 2,
    coordinator_id: DUDU,
    scored_at: "2026-10-18T15:07:00Z",
  },
  {
    room_id: ROOM_ID,
    round: 3,
    coordinator_id: ZE,
    scored_at: "2026-10-18T15:10:00Z",
  },
];

function defRow(x: D, mode: "progress" | "ballot" | "revealed") {
  return {
    id: x.id,
    room_id: ROOM_ID,
    round: x.round,
    player_id: mode === "ballot" ? "" : x.player_id,
    text: mode === "progress" ? "" : x.text,
    letter: mode === "progress" ? null : x.letter,
  };
}
function voteRows(filter: (v: [number, string, string]) => boolean) {
  return VOTES.filter(filter).map(([round, voter, def], i) => ({
    id: `v0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    room_id: ROOM_ID,
    round,
    voter_id: voter,
    definition_id: def,
  }));
}

export type Phase =
  | "lobby"
  | "choosing"
  | "writing"
  | "shuffling"
  | "voting"
  | "reveal"
  | "scoreboard"
  | "finished";

/**
 * Backend com a sala congelada na fase pedida, vista pela Bia (host).
 * `guest`: a Bia vê como convidada (o Zé é o host). `voted`: na votação, o
 * voto dela já está registrado (cédula escolhida com o anel rosa).
 */
export function roomBackend(
  phase: Phase,
  opts: {
    loggedIn?: boolean;
    guest?: boolean;
    voted?: boolean;
    longNames?: boolean;
  } = {},
): MockBackend {
  const now = Date.now();
  const inSecs = (s: number) => new Date(now + s * 1000).toISOString();
  const r3 = DEFS.filter((x) => x.round === 3);
  let round = 3;
  let coordinator: string | null = ZE;
  let wordId: string | null = WORD.id;
  let endsAt: string | null = null;
  let scores: Record<string, number> | null = AFTER_R2;
  let ids = PEOPLE.map((p) => p.id);
  let defs: Json[] = [];
  let votes: Json[] = [];

  switch (phase) {
    case "lobby":
      round = 0;
      coordinator = null;
      wordId = null;
      scores = null;
      ids = [BIA, LARA, TIO, DUDU];
      break;
    case "choosing":
      round = 4;
      coordinator = BIA;
      wordId = null;
      scores = AFTER_R3;
      endsAt = inSecs(25);
      break;
    case "writing":
      endsAt = inSecs(44);
      defs = r3
        .filter((x) => x.player_id === LARA || x.player_id === DUDU)
        .map((x) => defRow(x, "progress"));
      break;
    case "shuffling":
      defs = r3
        .filter((x) => x.player_id !== "__truth__")
        .map((x) => defRow(x, "progress"));
      break;
    case "voting":
      endsAt = inSecs(27);
      defs = r3
        .map((x) => defRow(x, "ballot"))
        .sort((a, b) => a.letter!.localeCompare(b.letter!));
      votes = voteRows(
        ([r, voter]) =>
          r === 3 &&
          (voter === LARA ||
            voter === DUDU ||
            voter === TIO ||
            (!!opts.voted && voter === BIA)),
      );
      break;
    case "reveal":
      scores = AFTER_R3;
      defs = r3.map((x) => defRow(x, "revealed"));
      votes = voteRows(([r]) => r === 3);
      break;
    case "scoreboard":
    case "finished":
      scores = AFTER_R3;
      defs = r3.map((x) => defRow(x, "revealed"));
      votes = voteRows(([r]) => r === 3);
      break;
  }

  const room = {
    id: ROOM_ID,
    code: ROOM_CODE,
    host_id: opts.guest ? ZE : BIA,
    status: phase,
    win_condition: "rounds",
    win_target: 10,
    current_round: round,
    current_coordinator: coordinator,
    current_word_id: wordId,
    used_word_ids: [],
    categories: [],
    round_phase_ends_at: endsAt,
    phase_started_at: inSecs(-5),
    created_at: "2026-10-18T15:00:00Z",
    mode: "individual",
    teams: [],
    nivel: "aleatorio",
  };
  const allDefs = DEFS.map((x) => defRow(x, "revealed"));
  const allVotes = voteRows(() => true);
  const word = wordId ? { ...WORD } : null;
  const roster = players(scores, ids, opts.longNames);

  return {
    user: opts.loggedIn ? { id: USER_ID, name: "Bia" } : null,
    rpc: {
      get_room_state: {
        room,
        players: roster,
        definitions: defs,
        votes,
        word,
      } as unknown as Json,
      get_round_sync: { definitions: defs, votes } as unknown as Json,
      // mesmo formato do servidor (revelação/placar/fim): o placar só aceita
      // o histórico com a revelação disponível (lib/score-history)
      get_room_reveal: {
        available: true,
        truth_def_ids: DEFS.filter((x) => x.player_id === "__truth__").map(
          (x) => x.id,
        ),
        near_truth_ids: NEAR_TRUTH,
      },
      get_room_definitions: allDefs as unknown as Json,
      get_random_word_prompts: [
        {
          id: "w-1",
          word: "alvíssaras",
          category: "comportamento",
          rarity: 3,
          nivel: "medio",
        },
        {
          id: "w-2",
          word: "quiproquó",
          category: "literatura",
          rarity: 3,
          nivel: "medio",
        },
        {
          id: "w-3",
          word: "zarabatana",
          category: "objeto",
          rarity: 2,
          nivel: "facil",
        },
      ],
      record_match_result: {
        xp_gained: 45,
        level: 7,
        unlocked: [],
        deduped: false,
      },
      get_client_config: null,
    },
    tables: {
      // O polling de saúde relê sala e jogadores direto das tabelas.
      rooms: [room as unknown as Record<string, Json>],
      players: roster as unknown as Array<Record<string, Json>>,
      words: [WORD as unknown as Record<string, Json>],
      round_extensions: [],
      room_words: [],
      votes: allVotes as unknown as Array<Record<string, Json>>,
      rounds: ROUNDS as unknown as Array<Record<string, Json>>,
      achievements: [],
    },
  };
}

/** localStorage que o app espera ver para a Bia: id local, apelido e a própria cédula. */
export function roomStorage(
  phase: Phase,
  opts: { guest?: boolean } = {},
): Record<string, string> {
  const s: Record<string, string> = {
    "verbete:player-id": ME,
    "verbete:nick": JSON.stringify("Bia"),
    "verbete:avatar": JSON.stringify("🦊"),
    "verbete:color": JSON.stringify("#FF5C8A"),
  };
  if (!opts.guest) s[`verbete:hosted:${ROOM_CODE}`] = JSON.stringify(ME);
  if (phase === "voting")
    s[`verbete:mydef:${ROOM_ID}:3`] = JSON.stringify(d(303));
  return s;
}

/** Desafio Diário: palavra da hora + (opcional) tentativa já feita. */
export function dailyBackend(state: "play" | "result"): MockBackend {
  const board = [
    { user_id: USER_ID, score: 78, is_correct: true, time_seconds: 22 },
    { user_id: "u-2", score: 71, is_correct: true, time_seconds: 29 },
    { user_id: "u-3", score: 64, is_correct: true, time_seconds: 41 },
    { user_id: "u-4", score: 0, is_correct: false, time_seconds: 55 },
  ];
  return {
    user: { id: USER_ID, name: "Bia" },
    rpc: {
      get_or_create_daily_challenge: {
        challenge: {
          id: "c-1",
          challenge_date: "2026-10-18",
          challenge_hour: "2026-10-18T15:00:00Z",
          word_id: "w-d",
        },
        word: { id: "w-d", word: "alvíssaras", category: "comportamento" },
      },
      get_my_daily_review:
        state === "result"
          ? {
              played: true,
              attempt: {
                guess: "recompensa dada a quem traz uma boa noticia",
                is_correct: true,
                score: 78,
                time_seconds: 22,
                similarity: 93,
                challenge_hour: "2026-10-18T15:00:00Z",
              },
              truth: "premio ou recompensa que se da a quem traz boas novas",
              word: "alvíssaras",
            }
          : { played: false },
      get_daily_leaderboard: state === "result" ? board : board.slice(1),
      get_client_config: null,
    },
    tables: {
      profiles: [
        {
          user_id: USER_ID,
          display_name: "Bia",
          avatar: "🦊",
          color: "#FF5C8A",
        },
        { user_id: "u-2", display_name: "Zé", avatar: "🐸", color: "#06D6A0" },
        {
          user_id: "u-3",
          display_name: "Nina",
          avatar: "🦄",
          color: "#A155F0",
        },
        {
          user_id: "u-4",
          display_name: "Dudu",
          avatar: "🐻",
          color: "#FFD166",
        },
      ],
      achievements: [],
      user_stats: [],
      daily_attempts: [],
    },
  };
}

/** Home: visitante (sem sessão) ou logada (cartão de streak). */
export function homeBackend(loggedIn: boolean): MockBackend {
  return {
    user: loggedIn ? { id: USER_ID, name: "Bia" } : null,
    rpc: { get_client_config: null },
    tables: {
      user_stats: [
        {
          user_id: USER_ID,
          games_played: 23,
          games_won: 9,
          current_streak: 5,
          best_streak: 12,
          last_played_date: new Date().toISOString().slice(0, 10),
        },
      ],
      daily_attempts: [{ id: "a-1", user_id: USER_ID }],
    },
  };
}
