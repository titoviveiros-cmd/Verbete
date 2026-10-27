import { supabase } from "@/integrations/supabase/client";
import { setStored, regeneratePlayerId } from "./player-id";
import { ensureAnonSession, SESSION_REQUIRED_MESSAGE } from "./auth-session";
import { assertTermsAccepted } from "./terms-consent";
import { WRITING_BASE_SECS, writingPhaseSecs } from "./game-times";
import { hedged } from "./hedge";
import { queueRoomConfig } from "./room-config-writer";
import { clearRoomOptimistic } from "./transition-floor";
import { nudgeRoundSync } from "./sync-nudge";
import {
  sanitizeDefinition,
  sanitizeNickname,
  humanizeMeaning,
  textSimilarity,
  wellFormedDefinition,
} from "./text-filter";
import {
  BOT_NAMES,
  BOT_FAKE_DEFINITIONS_TEMPLATES,
  randomBotDef,
} from "./bot-names";
import { randomAvatar, randomColor } from "./avatars";

export type RoomStatus =
  | "lobby"
  | "choosing"
  | "writing"
  | "shuffling"
  | "voting"
  | "reveal"
  | "scoreboard"
  | "finished";

export type RoomMode = "individual" | "teams";

export interface Team {
  id: string;
  name: string;
  color: string;
  emoji: string;
}

export interface Room {
  id: string;
  code: string;
  host_id: string;
  status: RoomStatus;
  win_condition: "rounds" | "score";
  win_target: number;
  current_round: number;
  current_coordinator: string | null;
  current_word_id: string | null;
  used_word_ids?: string[];
  categories?: string[];
  round_phase_ends_at: string | null;
  phase_started_at?: string | null;
  /** Partida pausada (todos os humanos fora) — playtest 2026-10-21. */
  paused_at?: string | null;
  created_at: string;
  mode?: RoomMode;
  teams?: Team[];
  nivel?: NivelFilter;
}

export interface Player {
  id: string;
  room_id: string;
  nickname: string;
  avatar: string;
  color: string;
  score: number;
  is_bot: boolean;
  is_connected: boolean;
  coordinator_count: number;
  joined_at: string;
  team_id?: string | null;
  writing_extensions?: number;
  voting_extensions?: number;
  kicked_at?: string | null;
}

// ---- Team presets ----
export const TEAM_PRESETS: Record<string, Team[]> = {
  "men-women": [
    { id: "men", name: "Homens", color: "#3B82F6", emoji: "👨" },
    { id: "women", name: "Mulheres", color: "#EC4899", emoji: "👩" },
  ],
  ab: [
    { id: "a", name: "Time A", color: "#FFD166", emoji: "🅰️" },
    { id: "b", name: "Time B", color: "#06D6A0", emoji: "🅱️" },
  ],
  abc: [
    { id: "a", name: "Time A", color: "#FFD166", emoji: "🅐" },
    { id: "b", name: "Time B", color: "#06D6A0", emoji: "🅑" },
    { id: "c", name: "Time C", color: "#EF476F", emoji: "🅒" },
  ],
};

export interface Word {
  id: string;
  word: string;
  // Fase 1 (segurança): meaning NÃO chega mais ao client durante a rodada —
  // as colunas reveladoras de words são bloqueadas por grants. O conteúdo
  // completo vem via get_word_reveal() apenas em reveal/scoreboard/finished.
  meaning?: string;
  category: string | null;
  rarity: number;
  // Campos v2 (podem ser nulos em palavras antigas/customizadas)
  classe?: string | null;
  origem?: string | null;
  curiosidade?: string | null;
  pronuncia?: string | null;
  exemplo?: string | null;
  sinonimos?: string[] | null;
  nivel?: string | null;
}

export type NivelFilter =
  "facil" | "medio" | "dificil" | "insano" | "aleatorio";

export interface Definition {
  id: string;
  room_id: string;
  round: number;
  player_id: string;
  text: string;
  letter: string | null;
  // Server-only columns (REVOKE SELECT for anon/authenticated).
  // Use `player_id === "__truth__"` to detect the truth client-side, and
  // the `get_round_reveal` / `get_room_reveal` RPCs for near_truth.
  is_truth?: boolean;
  near_truth?: boolean;
}

export const isTruthDef = (d: Pick<Definition, "player_id">) =>
  d.player_id === "__truth__";

export interface Vote {
  id: string;
  room_id: string;
  round: number;
  voter_id: string;
  definition_id: string;
}

export async function createRoom(
  hostId: string,
  nickname: string,
  avatar: string,
  color: string,
) {
  // Criação atômica (sala + jogador host) numa única RPC — o client não tem
  // permissão de escrita direta nas tabelas de jogo.
  assertTermsAccepted(); // o apelido já é conteúdo de usuário
  if (!(await ensureAnonSession())) throw new Error(SESSION_REQUIRED_MESSAGE);
  const cleanNick = sanitizeNickname(nickname);
  const callCreate = (pid: string) =>
    supabase.rpc("create_room_with_host", {
      p_host_id: pid,
      p_nickname: cleanNick,
      p_avatar: avatar,
      p_color: color,
    });
  let { data, error } = await callCreate(hostId);
  // S4: id local pertence a outra identidade — gera um novo e tenta 1x.
  if (error && String(error.message ?? "").includes("player_id_taken")) {
    ({ data, error } = await callCreate(regeneratePlayerId()));
  }
  if (error || !data) throw error ?? new Error("create_failed");
  const room = data as unknown as Room;
  // Amarra a identidade auth ao jogador do host (idempotente).
  supabase
    .rpc("claim_player_identity", {
      p_player_id: room.host_id,
    })
    .then(
      () => {},
      () => {},
    );
  return room;
}

export async function joinRoom(
  code: string,
  playerId: string,
  nickname: string,
  avatar: string,
  color: string,
) {
  // Toda entrada (Home, convite, volta do host, volta após remoção) passa aqui.
  assertTermsAccepted();
  if (!(await ensureAnonSession())) throw new Error(SESSION_REQUIRED_MESSAGE);
  // Leituras com "segunda via" (hedged): na medição de 2026-10-20 a
  // checagem de banimento travou 19,8 s e o host só viu o convidado
  // entrar 21,5 s depois. Mesma consulta, mesmo resultado.
  const { data: room, error } = await hedged(() =>
    supabase.from("rooms").select("*").eq("code", code).maybeSingle(),
  );
  if (error) throw error;
  if (!room) throw new Error("Sala não encontrada");

  // Bloqueia jogadores banidos antes de inserir na sala
  const { data: authData } = await supabase.auth.getUser();
  const authUserId = authData?.user?.id ?? null;
  const { data: banned } = await hedged(() =>
    supabase.rpc("is_player_banned", {
      _player_id: playerId,
      // A função SQL aceita NULL (visitante sem sessão), mas o tipo gerado
      // marca o arg como obrigatório — cast preserva o comportamento.
      _user_id: authUserId as unknown as string,
    }),
  );
  if (banned === true) {
    throw new Error(
      "Esta conta ou dispositivo foi banido por violar as regras da comunidade.",
    );
  }

  const cleanNick = sanitizeNickname(nickname);

  // Usa rejoin_room: se o jogador existir (mesmo kicked_at), preserva
  // a pontuação acumulada e zera apenas os contadores de penalidade.
  const callRejoin = (pid: string) =>
    supabase.rpc("rejoin_room", {
      p_code: code,
      p_player_id: pid,
      p_nickname: cleanNick,
      p_avatar: avatar,
      p_color: color,
    });
  let effectiveId = playerId;
  let { error: rpcErr } = await callRejoin(playerId);
  // S4: o id local pertence a outra identidade auth — gera um novo e
  // tenta 1x. O componente da sala relê getPlayerId() após a navegação.
  if (rpcErr && String(rpcErr.message ?? "").includes("player_id_taken")) {
    effectiveId = regeneratePlayerId();
    ({ error: rpcErr } = await callRejoin(effectiveId));
  }
  if (rpcErr) throw rpcErr;
  // Amarra a identidade auth ao jogador (idempotente; ignora sem sessão).
  supabase
    .rpc("claim_player_identity", {
      p_player_id: effectiveId,
    })
    .then(
      () => {},
      () => {},
    );
  return room as unknown as Room;
}

/** Reentra na sala após ser removido — preserva pontuação, zera advertências. */
export async function rejoinAfterKick(
  code: string,
  playerId: string,
  nickname: string,
  avatar: string,
  color: string,
) {
  return joinRoom(code, playerId, nickname, avatar, color);
}

export async function leaveRoom(playerId: string) {
  await supabase.rpc("leave_room", { p_player_id: playerId });
}

// Pede ao servidor a migração de host. Quem é o herdeiro (humano vivo mais
// antigo) e se o host atual realmente saiu é decidido lá, sob lock — o
// client só dispara. Returns true se a sala tem um host presente ao final.
export async function migrateHost(roomId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("migrate_host", {
    p_room_id: roomId,
  });
  if (error) {
    console.error("migrateHost failed", error);
    return false;
  }
  return (data as { ok?: boolean } | null)?.ok === true;
}

export async function kickPlayer(
  roomId: string,
  actorId: string,
  playerId: string,
) {
  // Otimismo: remove o jogador da UI local de quem clicou sem esperar o
  // echo de realtime (~300–500ms). Se a operação falhar, o próximo
  // postgres_changes/poll restaura o registro automaticamente.
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("player:optimistic-remove", { detail: { playerId } }),
    );
  }
  // RPC valida que actorId é o host da sala antes de remover/marcar kicked_at.
  // IMPORTANTE: chamamos .then() explicitamente para disparar a request HTTP —
  // o builder do supabase é "thenable", e `void builder` NÃO executa nada,
  // o que fazia o bot reaparecer (otimismo desfeito pelo próximo polling).
  supabase
    .rpc("kick_player", {
      p_room_id: roomId,
      p_actor_id: actorId,
      p_target_player_id: playerId,
    })
    .then(({ error }: { error: unknown }) => {
      if (error) {
        console.error("kick_player failed", error);
      }
    });
}

export async function addBot(roomId: string, actorId: string, index: number) {
  const id = "bot_" + Math.random().toString(36).slice(2, 10).padEnd(4, "0");
  const row = {
    id,
    room_id: roomId,
    nickname: BOT_NAMES[index % BOT_NAMES.length]!,
    avatar: randomAvatar(),
    color: randomColor(),
    is_bot: true,
  };
  // Atualização otimista: já injeta o bot no estado local imediatamente,
  // sem esperar o round-trip de DB nem o echo via realtime (~300–500ms).
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("player:optimistic-add", {
        detail: {
          roomId,
          player: {
            ...row,
            is_connected: true,
            joined_at: new Date().toISOString(),
            score: 0,
          },
        },
      }),
    );
  }
  // Fire-and-forget: chama .then() para realmente disparar a request HTTP
  // (PostgrestBuilder é "thenable" — `void builder` NÃO executa).
  const rollbackOptimisticBot = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("player:optimistic-remove", { detail: { playerId: id } }),
    );
  };
  supabase
    .rpc("add_bot", {
      p_room_id: roomId,
      p_actor_id: actorId,
      p_bot_id: id,
      p_nickname: row.nickname,
      p_avatar: row.avatar,
      p_color: row.color,
    })
    .then(({ data, error }) => {
      if (error || (data as { ok?: boolean } | null)?.ok !== true)
        rollbackOptimisticBot();
    }, rollbackOptimisticBot);
}

export async function setWinCondition(
  roomId: string,
  actorId: string,
  condition: "rounds" | "score",
  target: number,
) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: {
          roomId,
          patch: { win_condition: condition, win_target: target },
        },
      }),
    );
  }
  // Fila por sala: toques rápidos ("Rodadas" → "5 rod.") não podem chegar
  // fora de ordem ao servidor (ver room-config-writer.ts).
  void queueRoomConfig(roomId, actorId, {
    win_condition: condition,
    win_target: target,
  });
}

// ---------- Game flow (driven by host browser) ----------

export async function fetchThreeWords(
  excludeIds: string[] = [],
  categories: string[] = [],
  roomId?: string,
  nivel: NivelFilter = "aleatorio",
  // quantas devolver (a escolha da palavra pede candidatas a mais para ficar
  // só com as que cabem inteiras na tela — lib/word-fit.ts)
  count = 3,
): Promise<Word[]> {
  // 1) Palavras customizadas da sala (se houver) e 2) sorteio global, EM
  // PARALELO (playtest 2026-10-20: em série eram ≈0,52 s; juntas ≈0,27 s).
  // O sorteio pede as 3 de uma vez e usa só as que faltarem depois das
  // customizadas — as primeiras N de 3 aleatórias são N aleatórias: mesmas
  // regras (sem as usadas, raridade ≥ 2, categorias e nível da sala).
  // Só colunas não-reveladoras: o significado chega via get_word_reveal().
  // Cada leitura tem "segunda via" (hedged): uma consulta presa na rede não
  // segura o sorteio (na medição, room_words travou 25,9 s).
  const [customRes, globalRes] = await Promise.all([
    roomId
      ? hedged(() =>
          supabase
            .from("room_words")
            .select("id,word,category,created_at")
            .eq("room_id", roomId),
        )
      : Promise.resolve({ data: null }),
    // RPC segura: devolve apenas colunas não-reveladoras (sem meaning).
    hedged(() =>
      supabase.rpc("get_random_word_prompts", {
        exclude_ids: excludeIds,
        min_rarity: 2,
        lim: count,
        p_categories: categories,
        p_nivel: nivel,
      }),
    ),
  ]);
  let customPool: Word[] = [];
  const cw = customRes.data;
  if (cw && cw.length > 0) {
    customPool = cw
      .filter((w) => !excludeIds.includes(w.id))
      .map((w) => ({
        id: w.id,
        word: w.word,
        category: w.category ?? "custom",
        rarity: 2,
      }));
  }

  // Quantas faltam para completar `count`. Acima das 3 opções da escolha é
  // folga para o word-fit: as alternativas abaixo (sorteio sem filtro, tabela
  // crua) só entram se faltar para as 3 — como era com 3. Exigir as 9 trocava
  // um sorteio curto e bom pela tabela crua (CI do 7ea1e72, choosing-palavras).
  const needed = Math.max(0, count - Math.min(customPool.length, count));
  const atLeast = Math.min(needed, Math.max(0, 3 - customPool.length));
  let globalPool: Word[] = [];
  if (needed > 0) {
    const { data, error } = globalRes;
    if (!error && data && data.length >= atLeast) {
      globalPool = (data as Word[]).slice(0, needed);
    } else if (categories.length > 0 || nivel !== "aleatorio") {
      const { data: any3 } = await supabase.rpc("get_random_word_prompts", {
        exclude_ids: excludeIds,
        min_rarity: 2,
        lim: needed,
      });
      if (any3) globalPool = any3 as Word[];
    }
    if (globalPool.length < atLeast) {
      let q = supabase
        .from("words")
        .select("id,word,category,rarity,nivel,classe,pronuncia")
        .limit(120);
      if (excludeIds.length) q = q.not("id", "in", `(${excludeIds.join(",")})`);
      if (categories.length) q = q.in("category", categories);
      const { data: anyN } = await q;
      globalPool = shuffle(anyN ?? []).slice(0, needed) as unknown as Word[];
    }
  }

  // 3) Mescla em ORDEM DE PRIORIDADE — a escolha pede candidatas a mais e
  // fica com as primeiras que cabem na tela (lib/word-fit.ts): as da sala
  // (sorteadas), depois as do sorteio que seguem categorias/nível e só então
  // as que o servidor usou para completar (get_random_words: outra categoria,
  // outro nível, sem raridade mínima). Com 3 candidatas era isto mesmo: as de
  // fora só entravam se faltasse. Embaralhar tudo (como antes) misturava as de
  // fora entre as 9 e furava o filtro do lobby (Red Team 2026-10-24).
  const followsRoom = (w: Word) =>
    (categories.length === 0 || categories.includes(w.category ?? "")) &&
    (nivel === "aleatorio" ? w.rarity >= 2 : w.nivel === nivel);
  const pickedCustom = shuffle(customPool).slice(0, count);
  return [
    ...pickedCustom,
    ...globalPool.filter(followsRoom),
    ...globalPool.filter((w) => !followsRoom(w)),
  ].slice(0, count);
}

export async function setNivel(
  roomId: string,
  actorId: string,
  nivel: NivelFilter,
) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { nivel } },
      }),
    );
  }
  void queueRoomConfig(roomId, actorId, { nivel });
}

export async function setCategories(
  roomId: string,
  actorId: string,
  categories: string[],
) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { categories } },
      }),
    );
  }
  void queueRoomConfig(roomId, actorId, { categories });
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export async function startGame(room: Room) {
  // Sem coordenador provisório (playtest 2026-10-21): antes o app sorteava um
  // coordenador local e já virava a sala para "choosing"; ~1,2 s depois o
  // servidor confirmava OUTRO, a tela mostrava o errado e a escolha do bot
  // recomeçava a conta (~5,1 s de tela na 1ª rodada). Agora a sala só vira
  // com o coordenador AUTORITATIVO que a RPC devolve — no mesmo instante em
  // que os outros navegadores recebem a virada pelo realtime.
  const { data, error } = await supabase.rpc("start_game", {
    p_room_id: room.id,
  });
  const res = data as {
    ok?: boolean;
    reason?: string;
    coordinator?: string;
  } | null;
  if (error || res?.ok === false) {
    // Recusa (min_players, not_authorized, invalid_state…): nada foi mudado
    // na tela, então não há o que desfazer — o poll sincroniza se já começou.
    throw new Error(
      `start_game: ${error?.message ?? res?.reason ?? "recusado"}`,
    );
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: {
          roomId: room.id,
          patch: {
            status: "choosing",
            current_round: 1,
            current_coordinator: res?.coordinator ?? null,
            current_word_id: null,
          },
        },
      }),
    );
  }
}

export async function chooseWord(
  roomId: string,
  wordId: string,
  durationSec = WRITING_BASE_SECS,
  /** false = sem otimismo (quem só cobre a falta do host não pode mostrar
   *  uma palavra que talvez perca a corrida para a escolha dele). */
  opts: { optimistic?: boolean } = {},
) {
  // A escrita não escala com a sala (public.writing_phase_secs: base + 10 s);
  // o otimismo usa a mesma conta para a barra não "pular" quando o realtime
  // confirmar.
  const secs = writingPhaseSecs(durationSec);
  const ends = new Date(Date.now() + secs * 1000).toISOString();
  // Otimismo: transita para "writing" imediatamente para o coordenador e
  // demais clientes que estiverem ouvindo o evento. A RPC `choose_word` é
  // quem decide de fato (guarda atômica: status='choosing' + current_word_id
  // ainda nulo, sob lock de linha) — se perder a corrida, o realtime corrige.
  if (opts.optimistic !== false && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: {
          roomId,
          patch: {
            status: "writing",
            current_word_id: wordId,
            round_phase_ends_at: ends,
            phase_started_at: new Date().toISOString(),
          },
        },
      }),
    );
  }
  const { data, error } = await supabase.rpc("choose_word", {
    p_room_id: roomId,
    p_word_id: wordId,
    p_duration_sec: durationSec,
  });
  // Recusada (ou erro de rede): sem a janela otimista, a próxima leitura do
  // servidor corrige a tela na hora (Red Team 2026-10-22).
  if (
    opts.optimistic !== false &&
    (error || !(data as { ok?: boolean } | null)?.ok)
  )
    clearRoomOptimistic();
}

export class DuplicateDefinitionError extends Error {
  constructor(
    message = "Já existe uma definição igual a essa nesta rodada. Reescreva com suas próprias palavras.",
  ) {
    super(message);
    this.name = "DuplicateDefinitionError";
  }
}

function normalizeDefText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function submitDefinition(
  roomId: string,
  round: number,
  playerId: string,
  text: string,
  word?: string,
) {
  // Passa a palavra-alvo para o sanitizer detectar tentativas de "colar a resposta"
  // mesmo com acento/maiúscula/separadores que sobreviveriam à normalização básica.
  // (A definição VERDADEIRA é inserida só pelo servidor, em
  // advance_writing_to_voting — o client nunca a envia.)
  assertTermsAccepted();
  const clean = sanitizeDefinition(text, 140, word);
  // Dedup de texto agora é 100% server-side (submit_definition devolve
  // reason 'duplicate_definition') — o client não lê mais as definições
  // da rodada (Fase 1/S1).

  // Otimismo: já injeta a definição na UI local com id sintético
  // (`pending_${player}_${round}`). O reducer do realtime dedupica por
  // (player_id, round) quando o INSERT real chega, substituindo in-place.
  const pendingId = `pending_${playerId}_${round}`;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("definition:optimistic-add", {
        detail: {
          roomId,
          definition: {
            id: pendingId,
            room_id: roomId,
            round,
            player_id: playerId,
            text: clean,
            letter: null,
            is_truth: false,
          },
        },
      }),
    );
  }
  try {
    const { data, error } = await supabase.rpc("submit_definition", {
      p_room_id: roomId,
      p_player_id: playerId,
      p_text: clean,
    });
    if (error) throw error;
    if (data && (data as any).ok === false) {
      if ((data as any).reason === "duplicate_definition")
        throw new DuplicateDefinitionError();
      if ((data as any).reason === "too_similar")
        throw new DuplicateDefinitionError(
          "✋ Ficou muito parecida com outra definição desta rodada — muda umas palavras!",
        );
      throw new Error(`submit_definition rejected: ${(data as any).reason}`);
    }
    // Guarda o id da PRÓPRIA definição: na votação as cédulas chegam sem
    // autor (S1), então este id é a única forma de bloquear o self-vote
    // na UI (o servidor também bloqueia via trigger).
    const realId = (data as any)?.id;
    if (realId && typeof window !== "undefined") {
      setStored(`mydef:${roomId}:${round}`, String(realId));
    }
    nudgeRoundSync(roomId, round, "definition");
  } catch (e) {
    // Rollback do otimismo se a inserção falhou (ex.: erro de rede).
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("definition:optimistic-rollback", {
          detail: { roomId, pendingId },
        }),
      );
    }
    throw e;
  }
}

// Personas pseudo-fixas por bot: cada apelido herda sempre o mesmo estilo,
// para que "Profa. Trapaça" sempre escreva técnico, "TioBlefe" gíria etc.
const BOT_PERSONA_BY_NAME: Record<string, string> = {
  TioBlefe: "giria",
  MestreLero: "poetico",
  "Dona Lupa": "formal",
  "Zé Tagarela": "regional",
  "Profa. Trapaça": "tecnico",
  "Dr. Engano": "tecnico",
  "Vó Vera": "pratico",
  "Caco Esperto": "giria",
};
const PERSONA_POOL = [
  "formal",
  "giria",
  "tecnico",
  "regional",
  "poetico",
  "pratico",
];
function personaFor(bot: Player, idx: number): string {
  return (
    BOT_PERSONA_BY_NAME[bot.nickname] ??
    PERSONA_POOL[idx % PERSONA_POOL.length]!
  );
}

/** Parecido demais com o que um bot já disse na partida (mesma régua da edge v2). */
export const BOT_MATCH_REPEAT_SIMILARITY = 0.5;

/**
 * Uma linha por bot, sem repetição (playtest 2026-10-20): primeiro as
 * definições da IA já aprovadas pela edge v2 (filtros + juiz semântico), depois
 * as reservas que a edge vetou, por fim o reserva local. Nenhuma linha fica
 * igual/parecida com outra da rodada nem com o que um bot já disse em rodada
 * anterior DESTA partida (`previous`). Texto quebrado (forma, palavra da
 * rodada, máscara — wellFormedDefinition) é pulado: vai o próximo da fila.
 * Fila esgotada: o bot fica SEM linha (não envia) — nunca "texto (n)".
 * Pura — testável sem rede.
 */
export function assembleBotRows(input: {
  bots: Player[];
  ai: string[];
  vetted: string[];
  local: string[];
  previous: string[];
  word?: string;
  truth?: string;
}): Array<{ player_id: string; text: string }> {
  const used: string[] = input.previous.map(normalizeDefText).filter(Boolean);
  if (input.truth) used.push(normalizeDefText(humanizeMeaning(input.truth)));
  const tooClose = (n: string) =>
    used.some(
      (u) => u === n || textSimilarity(u, n) > BOT_MATCH_REPEAT_SIMILARITY,
    );
  const queue = [...input.ai, ...input.vetted, ...input.local];
  let q = 0;
  const next = (): string | null => {
    while (q < queue.length) {
      const text = wellFormedDefinition(queue[q++]!, input.word);
      if (!text) continue;
      const n = normalizeDefText(text);
      if (n && !tooClose(n)) return text;
    }
    return null;
  };
  const rows: Array<{ player_id: string; text: string }> = [];
  for (const bot of input.bots) {
    const text = next();
    if (text === null) break; // reserva esgotada: os que faltam não enviam
    used.push(normalizeDefText(text));
    rows.push({ player_id: bot.id, text });
  }
  return rows;
}

/** Textos dos bots nas rodadas ANTERIORES desta partida (vazio se falhar). */
async function matchBotTexts(roomId: string, botIds: Set<string>) {
  try {
    const { data } = await supabase.rpc("get_room_definitions", {
      p_room_id: roomId,
    });
    return ((data as Array<{ player_id: string; text: string }> | null) ?? [])
      .filter((d) => botIds.has(d.player_id))
      .map((d) => d.text);
  } catch {
    return [];
  }
}

export async function botSubmitDefinitions(
  roomId: string,
  round: number,
  bots: Player[],
  word?: Word | null,
  opts: { hurry?: PromiseLike<unknown> } = {},
) {
  if (bots.length === 0) return;
  // Sem pausa artificial depois da IA: os bots enviam assim que ela responde.
  // Fica só um piso desde o início da escrita, para o bot não "responder" no
  // instante em que a palavra aparece (playtest 2026-10-20).
  const startedAt = Date.now();
  const botIds = new Set(bots.map((b) => b.id));
  const personas = bots.map((b, i) => personaFor(b, i));
  // Reserva local embaralhada, de último caso (edge fora do ar ou lenta): a
  // edge v2 sorteia e veta as próprias reservas no servidor — o client nunca
  // manda texto para o juiz (não pode virar oráculo da verdade).
  const local = shuffle([...BOT_FAKE_DEFINITIONS_TEMPLATES]);
  const memory = matchBotTexts(roomId, botIds);

  let aiDefs: string[] = [];
  let vetted: string[] = [];
  if (word) {
    try {
      // v2: memória da PARTIDA + gate semântico com o juiz oficial do 🧠.
      const call = supabase.functions.invoke("bot-definitions-v2", {
        body: {
          word_id: word.id,
          count: bots.length,
          personas,
          room_id: roomId,
          round,
        },
      });
      // A mesa já escreveu e a IA estourou o prazo de graça: segue com o
      // reserva local — não espera a IA (BOT_AI_GRACE_MS).
      const res = opts.hurry
        ? await Promise.race([
            call,
            Promise.resolve(opts.hurry).then(() => null),
          ])
        : await call;
      if (res === null)
        console.warn(
          "bot-definitions: mesa pronta antes da IA — reserva local",
        );
      const data = (res?.data ?? null) as {
        definitions?: unknown;
        fallbacks?: unknown;
      } | null;
      const strings = (v: unknown) =>
        Array.isArray(v)
          ? v.filter((s): s is string => typeof s === "string" && s.length > 5)
          : [];
      aiDefs = strings(data?.definitions);
      vetted = strings(data?.fallbacks);
    } catch (e) {
      console.warn("bot-definitions AI failed, using fallback", e);
    }
  }
  // A memória da partida vem em paralelo; não segura a mesa (teto curto).
  const previous = await Promise.race([
    memory,
    new Promise<string[]>((r) => setTimeout(() => r([]), 1500)),
  ]);
  const delay = Math.max(0, BOT_WRITE_MIN_MS - (Date.now() - startedAt));

  setTimeout(async () => {
    const rows = assembleBotRows({
      bots,
      ai: aiDefs,
      vetted,
      local,
      previous,
      word: word?.word,
      truth: word?.meaning,
    });
    await submitBotRows(roomId, round, rows);
    // Nenhum bot sem definição (3 bots não travam a rodada): o servidor
    // pula texto idêntico a outro da rodada; quem ficou de fora vai de novo
    // com outra reserva. ON CONFLICT no servidor ignora quem já entrou.
    const missing = await missingBots(roomId, round, botIds);
    if (missing.length > 0) {
      const retry = assembleBotRows({
        bots: bots.filter((b) => missing.includes(b.id)),
        ai: [],
        vetted: [],
        local: shuffle([...BOT_FAKE_DEFINITIONS_TEMPLATES]),
        previous: [...previous, ...rows.map((r) => r.text)],
        word: word?.word,
        truth: word?.meaning,
      });
      await submitBotRows(roomId, round, retry);
    }
  }, delay);
}

async function submitBotRows(
  roomId: string,
  round: number,
  rows: Array<{ player_id: string; text: string }>,
) {
  if (rows.length === 0) return; // nenhum texto bem formado: o bot não envia
  try {
    const { data, error } = await supabase.rpc("submit_bot_definitions_bulk", {
      p_room_id: roomId,
      p_round: round,
      p_rows: rows,
    });
    // só avisa se o servidor gravou algo ({ok:false} ou 0 linhas = nada novo)
    const res = data as { ok?: boolean; inserted?: number } | null;
    if (!error && res?.ok && (res.inserted ?? 0) > 0)
      nudgeRoundSync(roomId, round, "bot_definitions");
  } catch {
    /* o timer da escrita e o servidor cobrem */
  }
}

/** Bots sem definição na rodada (pelo get_round_sync, que mostra autores). */
async function missingBots(
  roomId: string,
  round: number,
  botIds: Set<string>,
): Promise<string[]> {
  try {
    const { data } = await supabase.rpc("get_round_sync", {
      p_room_id: roomId,
    });
    const defs =
      (data as { definitions?: Array<{ player_id: string; round: number }> })
        ?.definitions ?? [];
    const done = new Set(
      defs.filter((d) => d.round === round).map((d) => d.player_id),
    );
    return [...botIds].filter((id) => !done.has(id));
  } catch {
    return [];
  }
}

// Gera UMA definição falsa no mesmo estilo dos bots, para o jogador humano
// usar como "auto" caso não queira digitar. Usa a edge function de bots
// (mesma IA + mesmas regras gramaticais), com fallback local.
export async function generateAiDefinitionForPlayer(
  word: Word,
  roomId?: string,
  round?: number,
): Promise<string> {
  // Estilos VÁLIDOS da v2 (os nomes antigos caíam no padrão "conciso" — o
  // mesmo da 1ª candidata dos bots e do 1º 💡: frases convergiam). Sem
  // "conciso" e "contextual", que os 💡 usam (Red Team 2026-10-22).
  const personas = [
    "analitico",
    "funcional",
    "descritivo",
    "comparativo",
    "acepcao",
    "popular",
  ];
  const persona = personas[Math.floor(Math.random() * personas.length)];

  // As definições da rodada não são legíveis pelo client (S1); colisão com
  // texto já enviado é barrada no servidor (submit_definition devolve
  // duplicate_definition e a UI pede para reescrever).
  const used = new Set<string>();

  try {
    // v2 (2026-10-22): a mesma edge dos bots — passa pelo juiz e só fica com
    // sugestão LONGE da verdade (nota < 50) e sem repetir a partida.
    const { data } = await supabase.functions.invoke("bot-definitions-v2", {
      body: {
        word_id: word.id,
        count: 1,
        personas: [persona],
        room_id: roomId,
        round,
      },
    });
    // 1ª bem formada (forma, palavra da rodada, sem máscara) — a quebrada é
    // pulada, nunca entregue ao jogador
    const firstOk = (arr: unknown) =>
      Array.isArray(arr)
        ? arr
            .filter((s): s is string => typeof s === "string" && s.length > 5)
            .map((s) => wellFormedDefinition(s, word.word))
            .find(
              (s): s is string => s !== null && !used.has(normalizeDefText(s)),
            )
        : undefined;
    // sem candidata da IA: a reserva que o SERVIDOR já vetou contra a
    // verdade (a lista local crua fica só como último recurso)
    const fbs = (data as any)?.fallbacks;
    const clean =
      firstOk((data as any)?.definitions) ??
      firstOk(Array.isArray(fbs) ? shuffle([...fbs]) : null);
    if (clean) return clean;
  } catch (e) {
    console.warn("generateAiDefinitionForPlayer failed, using fallback", e);
  }
  const pool = shuffle([...BOT_FAKE_DEFINITIONS_TEMPLATES]);
  for (const fb of pool) {
    const clean = wellFormedDefinition(fb, word.word);
    if (clean && !used.has(normalizeDefText(clean))) return clean;
  }
  // nenhuma bem formada (a palavra da rodada em todas?): sem sugestão — o
  // toque cai na reserva da tela; nunca um texto quebrado ou mascarado
  return "";
}

export async function startShuffling(roomId: string): Promise<boolean> {
  // Guarda atômica: a RPC só promove se ainda estiver em "writing". A UI
  // otimista só roda DEPOIS do retorno real para não pular a
  // penalidade/prorrogação quando ainda há humano sem definição.
  const { data, error } = await supabase.rpc("start_shuffling", {
    p_room_id: roomId,
  });
  if (error || !(data as any)?.ok) return false;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { status: "shuffling" } },
      }),
    );
  }
  return true;
}

export async function startVoting(
  roomId: string,
  _round: number,
  _word: Word,
  _defs: Definition[],
) {
  // `advance_writing_to_voting` é a única fonte de verdade: insere a
  // definição verdadeira se faltar, embaralha as letras e abre a votação —
  // tudo atomicamente sob lock de linha, e ela mesma re-checa se ainda
  // falta algum humano sem definição (no-op silencioso nesse caso, o que
  // substitui o polling de 8x250ms que existia aqui antes). Os parâmetros
  // round/word/defs continuam na assinatura só para não obrigar os
  // call-sites (Shuffling.tsx) a mudar; o estado real vem sempre do banco.
  await supabase.rpc("advance_writing_to_voting", {
    p_room_id: roomId,
  });
}

export async function castVote(
  roomId: string,
  round: number,
  voterId: string,
  definitionId: string,
) {
  // Otimismo: injeta o voto na UI local com id sintético
  // (`pending_${voter}_${round}`). O reducer dedupica por (voter_id, round)
  // quando o INSERT real chega via realtime.
  const pendingId = `pending_${voterId}_${round}`;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("vote:optimistic-add", {
        detail: {
          roomId,
          vote: {
            id: pendingId,
            room_id: roomId,
            round,
            voter_id: voterId,
            definition_id: definitionId,
          },
        },
      }),
    );
  }
  try {
    const { data, error } = await supabase.rpc("cast_vote", {
      p_room_id: roomId,
      p_voter_id: voterId,
      p_definition_id: definitionId,
    });
    if (error) throw error;
    if (data && (data as any).ok === false) {
      throw new Error(`cast_vote rejected: ${(data as any).reason}`);
    }
    nudgeRoundSync(roomId, round, "vote");
  } catch (e) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("vote:optimistic-rollback", {
          detail: { roomId, pendingId },
        }),
      );
    }
    throw e;
  }
}

/** Piso do envio dos bots na escrita, contado do início da chamada. */
export const BOT_WRITE_MIN_MS = 1500;
/**
 * Quanto a mesa espera a IA dos bots DEPOIS que todos os humanos já
 * escreveram. A IA responde em ~3–5 s na maioria das vezes; o prazo cobre
 * isso e corta só a cauda (timeouts de ~19 s medidos em 2026-10-20).
 */
export const BOT_AI_GRACE_MS = 6000;

/**
 * Votos dos bots (playtest 2026-10-22): quem escolhe é o SERVIDOR
 * (cast_bot_votes), onde a verdade é conhecida com segurança — 17,5% de
 * chance na verdade (nunca acima do chute às cegas) e, no resto, um blefe
 * aleatório que não seja o do bot. Antes o cliente sorteava entre todas as
 * cédulas (a verdade com o peso de cada blefe, ~1/3 numa mesa de 4) e os
 * bots disputavam a ponta. O cliente só pede, e o servidor só libera depois
 * que todos os humanos votaram (ou passado o prazo): com a política nova,
 * ver em que cédula um bot votou seria uma pista da verdade. Qualquer
 * humano da sala pode pedir (o host pode ter saído da tela).
 * "pending" = ainda há humano devendo o voto no servidor (tente de novo).
 * Banco ainda sem a política (migration pendente): o voto antigo, uniforme
 * entre as cédulas, só pelo host (cast_votes_bulk é dele).
 */
export async function castBotVotes(
  roomId: string,
  round: number,
  actorId: string,
  legacy: { isHost: boolean; bots: Player[]; ballot: Definition[] },
): Promise<"done" | "pending"> {
  if (legacy.bots.length === 0) return "done";
  const { data, error } = await supabase.rpc("cast_bot_votes", {
    p_room_id: roomId,
    p_round: round,
    p_actor_id: actorId,
  });
  if (error) {
    // a função não existe neste banco (PGRST202; 42883 com o cache de
    // esquema ainda velho logo depois de um rollback)
    if (error.code !== "PGRST202" && error.code !== "42883") throw error;
    if (!legacy.isHost) return "done";
    const rows = legacy.bots
      .map((bot) => {
        const choices = legacy.ballot.filter((d) => d.player_id !== bot.id);
        if (!choices.length) return null;
        const pick = choices[Math.floor(Math.random() * choices.length)]!;
        return { voter_id: bot.id, definition_id: pick.id };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length > 0)
      await supabase.rpc("cast_votes_bulk", {
        p_room_id: roomId,
        p_round: round,
        p_votes: rows,
      });
    return "done";
  }
  const res = data as { ok?: boolean; reason?: string } | null;
  if (res?.ok) {
    nudgeRoundSync(roomId, round, "bot_votes");
    return "done";
  }
  if (res?.reason === "humans_pending") return "pending";
  // a fase já andou: não há mais o que votar
  if (res?.reason === "invalid_state") return "done";
  throw new Error(`cast_bot_votes: ${res?.reason ?? "sem resposta"}`);
}

export async function revealAndScore(
  room: Room,
  _players: Player[],
  _defs: Definition[],
  _votes: Vote[],
  _coordinatorId: string,
): Promise<boolean> {
  // `advance_voting_to_reveal` é a única fonte de verdade agora: reavalia do
  // zero (sob lock de linha) se ainda falta humano sem voto — se faltar, é
  // um no-op silencioso e devolvemos false para o call-site tentar de novo
  // (mesmo contrato de antes). Se já foi pontuada por outro caminho (client
  // ou cron), o guard de idempotência do UNIQUE(room_id, round) garante que
  // não pontua duas vezes; ela só termina de mover o status pra "reveal".
  // A pontuação-base E o bônus de similaridade semântica (IA) são aplicados
  // atomicamente dentro da RPC — não há mais lógica de score aqui no client.
  await supabase.rpc("advance_voting_to_reveal", {
    p_room_id: room.id,
  });
  const { data } = await supabase
    .from("rooms")
    .select("status,current_round")
    .eq("id", room.id)
    .maybeSingle();
  const current = data as {
    status?: RoomStatus;
    current_round?: number;
  } | null;
  return (
    current?.current_round === room.current_round &&
    current?.status === "reveal"
  );
}

export async function goToScoreboard(roomId: string) {
  await supabase.rpc("finish_reveal", { p_room_id: roomId });
}

// Decide se vai pro placar da rodada ou direto pro fim de jogo (quando
// alguém atingiu a pontuação alvo escolhida pelo criador da sala). A RPC
// `finish_reveal` recalcula o placar (incl. modo equipes) direto no banco,
// sob lock de linha — elimina a corrida entre "status reveal chegou via
// realtime" e "os pontos ainda não chegaram" que existia na versão client.
export async function advanceAfterReveal(room: Room, _players: Player[]) {
  await supabase.rpc("finish_reveal", { p_room_id: room.id });
}

export async function nextRound(room: Room, _players: Player[]) {
  // `advance_scoreboard_to_next_round_or_finished` reavalia a condição de
  // vitória (pontos ou "todo mundo coordenou 2x") e escolhe o próximo
  // coordenador atomicamente. p_force=true porque esta é uma chamada
  // deliberada (host clicou "próxima rodada"), não o backstop do cron.
  await supabase.rpc("advance_scoreboard_to_next_round_or_finished", {
    p_room_id: room.id,
    p_force: true,
  });
}

export async function restartGame(roomId: string) {
  // Reset numa única transação no servidor (só o host; used_word_ids é
  // preservado — palavras já usadas continuam excluídas após reiniciar).
  const { error } = await supabase.rpc("reset_room", { p_room_id: roomId });
  if (error) console.error("reset_room failed", error);
}

// Chat da sala REMOVIDO do jogo (playtest 2026-10-20: pouco útil, tomava
// tela e um canal realtime por jogador). A tabela room_messages e a RPC
// send_room_message ficam DORMENTES no banco — limpeza estrutural é débito
// registrado (sem migration destrutiva nesta rodada).

// ============================================================
// Partida rápida (salas públicas): entra num lobby público com vaga
// ou cria um novo, tornando o chamador host. Tudo server-side.
// ============================================================
export async function joinPublicRoom(
  playerId: string,
  nickname: string,
  avatar: string,
  color: string,
): Promise<Room> {
  assertTermsAccepted();
  if (!(await ensureAnonSession())) throw new Error(SESSION_REQUIRED_MESSAGE);
  const cleanNick = sanitizeNickname(nickname);
  const callJoin = (pid: string) =>
    supabase.rpc("join_public_room", {
      p_player_id: pid,
      p_nickname: cleanNick,
      p_avatar: avatar,
      p_color: color,
    });
  let { data, error } = await callJoin(playerId);
  // S4: id local pertence a outra identidade — gera um novo e tenta 1x.
  if (error && String(error.message ?? "").includes("player_id_taken")) {
    ({ data, error } = await callJoin(regeneratePlayerId()));
  }
  if (error) {
    if (String(error.message ?? "").includes("player_banned")) {
      throw new Error(
        "Esta conta ou dispositivo foi banido por violar as regras da comunidade.",
      );
    }
    throw error;
  }
  if (!data) throw new Error("Não foi possível encontrar uma sala pública.");
  return data as unknown as Room;
}

export async function sendReaction(
  roomId: string,
  playerId: string,
  emoji: string,
) {
  // RPC com rate-limit servidor-side (800ms por jogador) e validação de pertencimento à sala.
  await supabase.rpc("send_reaction", {
    p_room_id: roomId,
    p_player_id: playerId,
    p_emoji: emoji,
  });
}

// ============================================================
// Times / modo de jogo
// ============================================================
export async function setRoomMode(
  roomId: string,
  actorId: string,
  mode: RoomMode,
  teams: Team[] = [],
) {
  const nextTeams = mode === "teams" ? teams : [];
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { mode, teams: nextTeams } },
      }),
    );
    if (mode === "individual") {
      window.dispatchEvent(
        new CustomEvent("players:optimistic-clear-team", {
          detail: { roomId },
        }),
      );
    }
  }
  // RPC já zera team_id de todos quando mode='individual'.
  void queueRoomConfig(roomId, actorId, { mode, teams: nextTeams });
}

export async function setRoomTeams(
  roomId: string,
  actorId: string,
  teams: Team[],
) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { teams } },
      }),
    );
  }
  void queueRoomConfig(roomId, actorId, { teams });
}

export async function assignPlayerToTeam(
  roomId: string,
  actorId: string,
  playerId: string,
  teamId: string | null,
) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("player:optimistic-update", {
        detail: { playerId, patch: { team_id: teamId } },
      }),
    );
  }
  // .then() explícito: o builder é "thenable" e `void builder` NÃO dispara a request.
  supabase
    .rpc("assign_player_team", {
      p_room_id: roomId,
      p_actor_id: actorId,
      p_player_id: playerId,
      p_team_id: teamId ?? "",
    })
    .then(
      ({ error }: { error: unknown }) => {
        if (error) console.error("assign_player_team" + " failed", error);
      },
      (e: unknown) => console.error("assign_player_team" + " failed", e),
    );
}

export async function autoBalanceTeams(
  roomId: string,
  actorId: string,
  players: Player[],
  teams: Team[],
) {
  if (!teams.length) return;
  // Distribui em round-robin pelos times (ordem aleatória)
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  shuffled.forEach((p, i) =>
    assignPlayerToTeam(roomId, actorId, p.id, teams[i % teams.length]!.id),
  );
}

export function computeTeamScores(players: Player[], teams: Team[]) {
  return teams.map((t) => {
    const members = players.filter((p) => p.team_id === t.id);
    return {
      ...t,
      score: members.reduce((s, p) => s + (p.score ?? 0), 0),
      members,
    };
  });
}

// ============================================================
// Prorrogação da fase de escrita (writing)
// Chamado pelo host quando o timer da fase writing zera.
// Regras:
//   - Para cada humano não-coordenador SEM definição na rodada:
//       * se writing_extensions < 2 → score -1, writing_extensions++, dá +20s pra TODA a sala
//       * se writing_extensions == 2 → score -1, REMOVE o jogador da partida
//   - Se ninguém precisou de prorrogação, retorna { extended: false } e o
//     chamador deve seguir o fluxo normal (startShuffling).
// ============================================================
export async function applyWritingTimeoutOrAdvance(roomId: string): Promise<{
  action: string;
  extended: boolean;
  paused: boolean;
  kickedIds: string[];
}> {
  const { data, error } = await supabase.rpc("extend_writing_or_advance", {
    p_room_id: roomId,
  });
  if (error) {
    console.error("extend_writing_or_advance failed", error);
    return { action: "error", extended: false, paused: false, kickedIds: [] };
  }
  const payload = (data ?? {}) as { action?: string; kicked?: string[] };
  return {
    action: payload.action ?? "noop",
    extended: payload.action === "extended",
    // Mesa inteira fora (pausa de partida): ninguém avança a fase.
    paused: payload.action === "paused",
    kickedIds: payload.kicked ?? [],
  };
}

// ============================================================
// Prorrogação da fase de votação (voting)
// Mesma dinâmica de writing, porém com tempo proporcionalmente menor (15s).
//   - Para cada humano conectado SEM voto na rodada:
//       * se voting_extensions < 2 → score -1, voting_extensions++, +15s pra sala
//       * se voting_extensions == 2 → score -1, REMOVE o jogador
//   - Se ninguém precisou de prorrogação, retorna { extended: false } e o
//     chamador deve seguir o fluxo normal (revealAndScore).
// ============================================================
export async function applyVotingTimeoutOrAdvance(roomId: string): Promise<{
  action: string;
  extended: boolean;
  advanced: boolean;
  kickedIds: string[];
}> {
  const { data, error } = await supabase.rpc("extend_voting_or_advance", {
    p_room_id: roomId,
  });
  if (error) {
    console.error("extend_voting_or_advance failed", error);
    return { action: "error", extended: false, advanced: false, kickedIds: [] };
  }
  const payload = (data ?? {}) as { action?: string; kicked?: string[] };
  return {
    action: payload.action ?? "noop",
    extended: payload.action === "extended",
    advanced: payload.action === "advanced",
    kickedIds: payload.kicked ?? [],
  };
}
