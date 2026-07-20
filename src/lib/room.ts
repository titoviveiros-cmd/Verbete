import { supabase } from "@/integrations/supabase/client";
import { setStored, regeneratePlayerId } from "./player-id";
import { ensureAnonSession } from "./auth-session";
import {
  sanitizeDefinition,
  sanitizeNickname,
  humanizeMeaning,
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

function genCode(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

export async function createRoom(
  hostId: string,
  nickname: string,
  avatar: string,
  color: string,
) {
  // Single-RPC creation (rooms+player insert in one transaction). Falls back to legacy path on error.
  await ensureAnonSession();
  const cleanNick = sanitizeNickname(nickname);
  const callCreate = (pid: string) =>
    (supabase.rpc as any)("create_room_with_host", {
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
  if (!error && data) {
    const room = data as Room;
    // Amarra a identidade auth ao jogador do host (idempotente).
    (supabase.rpc as any)("claim_player_identity", {
      p_player_id: room.host_id,
    }).then(
      () => {},
      () => {},
    );
    return room;
  }

  // Fallback (RPC unavailable)
  let code = genCode();
  for (let i = 0; i < 5; i++) {
    const { data: existing } = await supabase
      .from("rooms")
      .select("id")
      .eq("code", code)
      .maybeSingle();
    if (!existing) break;
    code = genCode();
  }
  const { data: room, error: roomErr } = await supabase
    .from("rooms")
    .insert({ code, host_id: hostId, status: "lobby" })
    .select()
    .single();
  if (roomErr || !room) throw roomErr ?? new Error("create_failed");
  await supabase.from("players").insert({
    id: hostId,
    room_id: room.id,
    nickname: cleanNick,
    avatar,
    color,
  });
  return room as unknown as Room;
}

export async function joinRoom(
  code: string,
  playerId: string,
  nickname: string,
  avatar: string,
  color: string,
) {
  await ensureAnonSession();
  const { data: room, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  if (!room) throw new Error("Sala não encontrada");

  // Bloqueia jogadores banidos antes de inserir na sala
  const { data: authData } = await supabase.auth.getUser();
  const authUserId = authData?.user?.id ?? null;
  const { data: banned } = await (supabase.rpc as any)("is_player_banned", {
    _player_id: playerId,
    _user_id: authUserId,
  });
  if (banned === true) {
    throw new Error(
      "Esta conta ou dispositivo foi banido por violar as regras da comunidade.",
    );
  }

  const cleanNick = sanitizeNickname(nickname);

  // Usa rejoin_room: se o jogador existir (mesmo kicked_at), preserva
  // a pontuação acumulada e zera apenas os contadores de penalidade.
  const callRejoin = (pid: string) =>
    (supabase.rpc as any)("rejoin_room", {
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
  if (rpcErr) {
    // Fallback legado
    await supabase.from("players").upsert({
      id: effectiveId,
      room_id: room.id,
      nickname: cleanNick,
      avatar,
      color,
      is_connected: true,
    });
  }
  // Amarra a identidade auth ao jogador (idempotente; ignora sem sessão).
  (supabase.rpc as any)("claim_player_identity", {
    p_player_id: effectiveId,
  }).then(
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
  await (supabase.rpc as any)("leave_room", { p_player_id: playerId });
}

// Promove `newHostId` a host da sala, mas SÓ se o host atual continuar sendo
// `expectedCurrentHostId` (evita corrida quando vários clientes tentam migrar
// ao mesmo tempo). Returns true se a promoção foi efetiva.
export async function migrateHost(
  roomId: string,
  expectedCurrentHostId: string,
  newHostId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("rooms")
    .update({ host_id: newHostId })
    .eq("id", roomId)
    .eq("host_id", expectedCurrentHostId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("migrateHost failed", error);
    return false;
  }
  return !!data;
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
  (supabase.rpc as any)("kick_player", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_target_player_id: playerId,
  }).then(({ error }: { error: unknown }) => {
    if (error) {
      console.error("kick_player failed", error);
    }
  });
}

export async function addBot(roomId: string, index: number) {
  const id = "bot_" + Math.random().toString(36).slice(2, 10);
  const row = {
    id,
    room_id: roomId,
    nickname: BOT_NAMES[index % BOT_NAMES.length],
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
    .from("players")
    .insert(row)
    .then(({ error }) => {
      if (error) rollbackOptimisticBot();
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
  // .then() explícito: o builder é "thenable" e `void builder` NÃO dispara a request.
  (supabase.rpc as any)("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: { win_condition: condition, win_target: target },
  }).then(
    ({ error }: { error: unknown }) => {
      if (error) console.error("host_update_room_config" + " failed", error);
    },
    (e: unknown) => console.error("host_update_room_config" + " failed", e),
  );
}

// ---------- Game flow (driven by host browser) ----------

export async function fetchThreeWords(
  excludeIds: string[] = [],
  categories: string[] = [],
  roomId?: string,
  nivel: NivelFilter = "aleatorio",
): Promise<Word[]> {
  // 1) Coleta palavras customizadas da sala (se houver) ainda não usadas
  let customPool: Word[] = [];
  if (roomId) {
    const { data: cw } = await supabase
      .from("room_words")
      .select("id,word,meaning,category,created_at")
      .eq("room_id", roomId);
    if (cw && cw.length > 0) {
      customPool = (cw as any[])
        .filter((w) => !excludeIds.includes(w.id))
        .map((w) => ({
          id: w.id,
          word: w.word,
          meaning: w.meaning,
          category: w.category ?? "custom",
          rarity: 2,
        })) as Word[];
    }
  }

  // 2) Quantas faltam para completar 3
  const needed = Math.max(0, 3 - Math.min(customPool.length, 3));
  let globalPool: Word[] = [];
  if (needed > 0) {
    // RPC segura: devolve apenas colunas não-reveladoras (sem meaning).
    const { data, error } = await (supabase.rpc as any)(
      "get_random_word_prompts",
      {
        exclude_ids: excludeIds,
        min_rarity: 2,
        lim: needed,
        p_categories: categories,
        p_nivel: nivel,
      },
    );
    if (!error && data && data.length >= needed) {
      globalPool = data as Word[];
    } else if (categories.length > 0 || nivel !== "aleatorio") {
      const { data: any3 } = await (supabase.rpc as any)(
        "get_random_word_prompts",
        {
          exclude_ids: excludeIds,
          min_rarity: 2,
          lim: needed,
        },
      );
      if (any3) globalPool = any3 as Word[];
    }
    if (globalPool.length < needed) {
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

  // 3) Mescla: pega até 3 customs (sorteadas) + completa com globais
  const pickedCustom = shuffle(customPool).slice(0, 3);
  return shuffle([...pickedCustom, ...globalPool]).slice(0, 3);
}

export type RoomWord = {
  id: string;
  room_id: string;
  word: string;
  meaning: string;
  category: string | null;
  created_by: string | null;
  created_at: string;
};

export async function fetchRoomWords(roomId: string): Promise<RoomWord[]> {
  const { data } = await supabase
    .from("room_words")
    .select("*")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false });
  return (data as RoomWord[]) ?? [];
}

export async function addRoomWord(
  roomId: string,
  playerId: string,
  word: string,
  meaning: string,
) {
  const cleanWord = word.trim().slice(0, 40);
  const cleanMeaning = meaning.trim().slice(0, 220);
  if (!cleanWord || !cleanMeaning) return null;
  const { data, error } = await supabase
    .from("room_words")
    .insert({
      room_id: roomId,
      created_by: playerId,
      word: cleanWord,
      meaning: cleanMeaning,
    })
    .select()
    .single();
  if (error) return null;
  return data as RoomWord;
}

export async function deleteRoomWord(id: string) {
  await supabase.from("room_words").delete().eq("id", id);
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
  // .then() explícito: o builder é "thenable" e `void builder` NÃO dispara a request.
  (supabase.rpc as any)("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: { nivel },
  }).then(
    ({ error }: { error: unknown }) => {
      if (error) console.error("host_update_room_config" + " failed", error);
    },
    (e: unknown) => console.error("host_update_room_config" + " failed", e),
  );
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
  // .then() explícito: o builder é "thenable" e `void builder` NÃO dispara a request.
  (supabase.rpc as any)("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: { categories },
  }).then(
    ({ error }: { error: unknown }) => {
      if (error) console.error("host_update_room_config" + " failed", error);
    },
    (e: unknown) => console.error("host_update_room_config" + " failed", e),
  );
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function startGame(room: Room, players: Player[]) {
  const resetPlayers = players.map((p) => ({
    ...p,
    score: 0,
    coordinator_count: 0,
  }));
  const next = pickNextCoordinator(resetPlayers, null);
  // Otimismo: já transita a sala para "choosing" localmente para a UI sair
  // do lobby instantaneamente, enquanto a RPC (autoritativa) roda o reset
  // completo (players/defs/votes/rounds) numa única transação no servidor.
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: {
          roomId: room.id,
          patch: {
            status: "choosing",
            current_round: 1,
            current_coordinator: next.id,
            current_word_id: null,
          },
        },
      }),
    );
  }
  await (supabase.rpc as any)("start_game", { p_room_id: room.id });
}

function pickNextCoordinator(
  players: Player[],
  lastCoord: string | null,
): Player {
  // Prefer players with the lowest coordinator_count, exclude last
  const candidates = players.filter((p) => p.id !== lastCoord);
  const pool = candidates.length > 0 ? candidates : players;
  const minCount = Math.min(...pool.map((p) => p.coordinator_count));
  const tier = pool.filter((p) => p.coordinator_count === minCount);
  return tier[Math.floor(Math.random() * tier.length)];
}

export async function chooseWord(
  roomId: string,
  wordId: string,
  durationSec = 60,
) {
  const ends = new Date(Date.now() + durationSec * 1000).toISOString();
  // Otimismo: transita para "writing" imediatamente para o coordenador e
  // demais clientes que estiverem ouvindo o evento. A RPC `choose_word` é
  // quem decide de fato (guarda atômica: status='choosing' + current_word_id
  // ainda nulo, sob lock de linha) — se perder a corrida, o realtime corrige.
  if (typeof window !== "undefined") {
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
  await (supabase.rpc as any)("choose_word", {
    p_room_id: roomId,
    p_word_id: wordId,
    p_duration_sec: durationSec,
  });
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
  isTruth = false,
  word?: string,
) {
  // Passa a palavra-alvo para o sanitizer detectar tentativas de "colar a resposta"
  // mesmo com acento/maiúscula/separadores que sobreviveriam à normalização básica.
  const clean = sanitizeDefinition(text, 140, isTruth ? undefined : word);
  // Dedup de texto agora é 100% server-side (submit_definition devolve
  // reason 'duplicate_definition') — o client não lê mais as definições
  // da rodada (Fase 1/S1).

  // Otimismo: já injeta a definição na UI local com id sintético
  // (`pending_${player}_${round}`). O reducer do realtime dedupica por
  // (player_id, round) quando o INSERT real chega, substituindo in-place.
  const pendingId = `pending_${playerId}_${round}`;
  if (typeof window !== "undefined" && !isTruth) {
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
    if (isTruth) {
      // Definição verdadeira (chamada pelo host na transição p/ votação)
      const { data, error } = await (supabase.rpc as any)(
        "insert_truth_definition",
        {
          p_room_id: roomId,
          p_round: round,
          p_text: clean,
        },
      );
      if (error) throw error;
      if (data && (data as any).ok === false) {
        throw new Error(
          `insert_truth_definition rejected: ${(data as any).reason}`,
        );
      }
    } else {
      const { data, error } = await (supabase.rpc as any)("submit_definition", {
        p_room_id: roomId,
        p_player_id: playerId,
        p_text: clean,
      });
      if (error) throw error;
      if (data && (data as any).ok === false) {
        if ((data as any).reason === "duplicate_definition")
          throw new DuplicateDefinitionError();
        throw new Error(`submit_definition rejected: ${(data as any).reason}`);
      }
      // Guarda o id da PRÓPRIA definição: na votação as cédulas chegam sem
      // autor (S1), então este id é a única forma de bloquear o self-vote
      // na UI (o servidor também bloqueia via trigger).
      const realId = (data as any)?.id;
      if (realId && typeof window !== "undefined") {
        setStored(`mydef:${roomId}:${round}`, String(realId));
      }
    }
  } catch (e) {
    // Rollback do otimismo se a inserção falhou (ex.: erro de rede).
    if (typeof window !== "undefined" && !isTruth) {
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
    BOT_PERSONA_BY_NAME[bot.nickname] ?? PERSONA_POOL[idx % PERSONA_POOL.length]
  );
}

export async function botSubmitDefinitions(
  roomId: string,
  round: number,
  bots: Player[],
  word?: Word | null,
) {
  if (bots.length === 0) return;
  // Delay curto: a chamada de IA acima já leva 1-3s; somado a um atraso
  // longo os bots pareciam travados na fase de escrita (feedback de playtest).
  const delay = 400 + Math.random() * 800;

  // Tenta usar IA (Gemini Flash) para definições falsas plausíveis;
  // se falhar (sem chave, timeout, etc.) cai no fallback local.
  let aiDefs: string[] = [];
  const personas = bots.map((b, i) => personaFor(b, i));
  if (word) {
    try {
      const { data } = await supabase.functions.invoke("bot-definitions", {
        body: { word_id: word.id, count: bots.length, personas },
      });
      const arr = (data as any)?.definitions;
      if (Array.isArray(arr))
        aiDefs = arr.filter((s) => typeof s === "string" && s.length > 5);
    } catch (e) {
      console.warn("bot-definitions AI failed, using fallback", e);
    }
  }

  setTimeout(async () => {
    // Dedup: bots NUNCA devem dar a mesma resposta (entre si, igual à verdade,
    // ou igual a uma definição já enviada por qualquer outro jogador humano).
    const norm = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const used = new Set<string>();
    if (word?.meaning) used.add(norm(humanizeMeaning(word.meaning)));

    // Carrega definições já existentes nessa rodada (humanos + verdade) para
    // que os bots evitem repetir o que já foi enviado.
    try {
      const { data: existing } = await supabase
        .from("definitions")
        .select("text")
        .eq("room_id", roomId)
        .eq("round", round);
      if (Array.isArray(existing)) {
        for (const row of existing) {
          const t = (row as { text?: string }).text;
          if (typeof t === "string" && t.length > 0) used.add(norm(t));
        }
      }
    } catch (e) {
      console.warn("botSubmitDefinitions: failed to load existing defs", e);
    }

    // Pool de fallback embaralhado para evitar colisões aleatórias.
    const fallbackPool = [...BOT_FAKE_DEFINITIONS_TEMPLATES].sort(
      () => Math.random() - 0.5,
    );
    let fbIdx = 0;
    const nextFallback = (): string => {
      for (let k = 0; k < fallbackPool.length; k++) {
        const cand = fallbackPool[(fbIdx + k) % fallbackPool.length];
        if (!used.has(norm(cand))) {
          fbIdx = (fbIdx + k + 1) % fallbackPool.length;
          return cand;
        }
      }
      // todos usados — gera variação numérica para garantir unicidade
      return `${fallbackPool[fbIdx++ % fallbackPool.length]} (${Math.floor(Math.random() * 999)})`;
    };

    const rows = bots.map((bot, i) => {
      let raw = aiDefs[i];
      if (!raw || used.has(norm(raw))) raw = nextFallback();
      let text = sanitizeDefinition(raw, 140, word?.word);
      let key = norm(text);
      // Se ainda colidir após sanitizar, tenta fallbacks até achar único.
      let attempts = 0;
      while (used.has(key) && attempts < fallbackPool.length + 2) {
        text = sanitizeDefinition(nextFallback(), 140, word?.word);
        key = norm(text);
        attempts++;
      }
      used.add(key);
      return { player_id: bot.id, text };
    });
    (supabase.rpc as any)("submit_bot_definitions_bulk", {
      p_room_id: roomId,
      p_round: round,
      p_rows: rows,
    }).then(
      () => {},
      () => {},
    );
  }, delay);
}

// Gera UMA definição falsa no mesmo estilo dos bots, para o jogador humano
// usar como "auto" caso não queira digitar. Usa a edge function de bots
// (mesma IA + mesmas regras gramaticais), com fallback local.
export async function generateAiDefinitionForPlayer(
  word: Word,
  roomId?: string,
  round?: number,
): Promise<string> {
  const personas = [
    "formal",
    "giria",
    "tecnico",
    "regional",
    "poetico",
    "pratico",
  ];
  const persona = personas[Math.floor(Math.random() * personas.length)];

  // Evita colisão com definições já enviadas na rodada: sem a chave de IA,
  // bots e o "gerar automática" sorteiam do MESMO pool de templates — sem
  // este dedup, o jogador recebia "definição igual" ao tentar enviar.
  const used = new Set<string>();
  if (roomId && round != null) {
    try {
      const { data: existing } = await supabase
        .from("definitions")
        .select("text")
        .eq("room_id", roomId)
        .eq("round", round);
      for (const row of existing ?? []) {
        const t = (row as { text?: string }).text;
        if (t) used.add(normalizeDefText(t));
      }
    } catch {
      /* dedup é melhor-esforço */
    }
  }

  try {
    const { data } = await supabase.functions.invoke("bot-definitions", {
      body: { word_id: word.id, count: 1, personas: [persona] },
    });
    const arr = (data as any)?.definitions;
    const raw = Array.isArray(arr)
      ? arr.find(
          (s: unknown) => typeof s === "string" && (s as string).length > 5,
        )
      : null;
    if (raw) {
      const clean = sanitizeDefinition(raw as string, 140, word.word);
      if (!used.has(normalizeDefText(clean))) return clean;
    }
  } catch (e) {
    console.warn("generateAiDefinitionForPlayer failed, using fallback", e);
  }
  const pool = shuffle([...BOT_FAKE_DEFINITIONS_TEMPLATES]);
  for (const fb of pool) {
    const clean = sanitizeDefinition(fb, 140, word.word);
    if (!used.has(normalizeDefText(clean))) return clean;
  }
  return sanitizeDefinition(pool[0] + " incomum", 140, word.word);
}

export async function startShuffling(roomId: string): Promise<boolean> {
  // Guarda atômica: a RPC só promove se ainda estiver em "writing". A UI
  // otimista só roda DEPOIS do retorno real para não pular a
  // penalidade/prorrogação quando ainda há humano sem definição.
  const { data, error } = await (supabase.rpc as any)("start_shuffling", {
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
  await (supabase.rpc as any)("advance_writing_to_voting", {
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
    const { data, error } = await (supabase.rpc as any)("cast_vote", {
      p_room_id: roomId,
      p_voter_id: voterId,
      p_definition_id: definitionId,
    });
    if (error) throw error;
    if (data && (data as any).ok === false) {
      throw new Error(`cast_vote rejected: ${(data as any).reason}`);
    }
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

export async function botsVote(
  roomId: string,
  round: number,
  bots: Player[],
  defs: Definition[],
) {
  if (bots.length === 0) return;
  const delay = 900 + Math.random() * 1400;
  setTimeout(() => {
    const rows = bots
      .map((bot) => {
        const choices = defs.filter((d) => d.player_id !== bot.id);
        if (!choices.length) return null;
        const pick = choices[Math.floor(Math.random() * choices.length)];
        return { voter_id: bot.id, definition_id: pick.id };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return;
    (supabase.rpc as any)("cast_votes_bulk", {
      p_room_id: roomId,
      p_round: round,
      p_votes: rows,
    }).then(
      () => {},
      () => {},
    );
  }, delay);
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
  await (supabase.rpc as any)("advance_voting_to_reveal", {
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
  await (supabase.rpc as any)("finish_reveal", { p_room_id: roomId });
}

// Decide se vai pro placar da rodada ou direto pro fim de jogo (quando
// alguém atingiu a pontuação alvo escolhida pelo criador da sala). A RPC
// `finish_reveal` recalcula o placar (incl. modo equipes) direto no banco,
// sob lock de linha — elimina a corrida entre "status reveal chegou via
// realtime" e "os pontos ainda não chegaram" que existia na versão client.
export async function advanceAfterReveal(room: Room, _players: Player[]) {
  await (supabase.rpc as any)("finish_reveal", { p_room_id: room.id });
}

export async function nextRound(room: Room, _players: Player[]) {
  // `advance_scoreboard_to_next_round_or_finished` reavalia a condição de
  // vitória (pontos ou "todo mundo coordenou 2x") e escolhe o próximo
  // coordenador atomicamente. p_force=true porque esta é uma chamada
  // deliberada (host clicou "próxima rodada"), não o backstop do cron.
  await (supabase.rpc as any)("advance_scoreboard_to_next_round_or_finished", {
    p_room_id: room.id,
    p_force: true,
  });
}

export async function restartGame(roomId: string) {
  // Single-transaction reset via server RPC
  const { error } = await supabase.rpc("reset_room", { p_room_id: roomId });
  if (!error) return;
  // Fallback (RPC unavailable): legacy sequential reset
  const { data: ps } = await supabase
    .from("players")
    .select("id")
    .eq("room_id", roomId);
  if (ps) {
    await Promise.all(
      ps.map((p) =>
        supabase
          .from("players")
          .update({
            score: 0,
            coordinator_count: 0,
            writing_extensions: 0,
            voting_extensions: 0,
          })
          .eq("id", p.id),
      ),
    );
  }
  await Promise.all([
    supabase.from("definitions").delete().eq("room_id", roomId),
    supabase.from("votes").delete().eq("room_id", roomId),
    supabase.from("rounds").delete().eq("room_id", roomId),
  ]);
  // IMPORTANT: do NOT clear used_word_ids — palavras já usadas continuam excluídas mesmo após reiniciar
  await supabase
    .from("rooms")
    .update({
      status: "lobby",
      current_round: 0,
      current_coordinator: null,
      current_word_id: null,
      round_phase_ends_at: null,
    })
    .eq("id", roomId);
}

// ============================================================
// Chat de sala (spec: lobby livre, rodada desativado, pós-resultado ativado —
// a regra de fase é validada server-side pela RPC send_room_message)
// ============================================================
export interface RoomMessage {
  id: string;
  room_id: string;
  player_id: string;
  text: string;
  created_at: string;
}

export const CHAT_ENABLED_STATUSES: RoomStatus[] = [
  "lobby",
  "reveal",
  "scoreboard",
  "finished",
];

export async function sendRoomMessage(
  roomId: string,
  playerId: string,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  const clean = sanitizeDefinition(text, 200);
  if (!clean) return { ok: false, reason: "empty" };
  const { data, error } = await (supabase.rpc as any)("send_room_message", {
    p_room_id: roomId,
    p_player_id: playerId,
    p_text: clean,
  });
  if (error) return { ok: false, reason: error.message };
  return (data as { ok: boolean; reason?: string }) ?? { ok: false };
}

export async function fetchRoomMessages(
  roomId: string,
  limit = 50,
): Promise<RoomMessage[]> {
  // Cast: room_messages ainda não existe nos tipos gerados do Supabase
  // (src/integrations/supabase/types.ts é do schema antigo). Regenerar os
  // tipos após aplicar as migrations remove a necessidade do cast.
  const { data } = await (supabase.from as any)("room_messages")
    .select("*")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data as RoomMessage[]) ?? []).reverse();
}

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
  const cleanNick = sanitizeNickname(nickname);
  const { data, error } = await (supabase.rpc as any)("join_public_room", {
    p_player_id: playerId,
    p_nickname: cleanNick,
    p_avatar: avatar,
    p_color: color,
  });
  if (error) {
    if (String(error.message ?? "").includes("player_banned")) {
      throw new Error(
        "Esta conta ou dispositivo foi banido por violar as regras da comunidade.",
      );
    }
    throw error;
  }
  if (!data) throw new Error("Não foi possível encontrar uma sala pública.");
  return data as Room;
}

export async function sendReaction(
  roomId: string,
  playerId: string,
  emoji: string,
) {
  // RPC com rate-limit servidor-side (800ms por jogador) e validação de pertencimento à sala.
  await (supabase.rpc as any)("send_reaction", {
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
  // .then() explícito: o builder é "thenable" e `void builder` NÃO dispara a request.
  (supabase.rpc as any)("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: { mode, teams: nextTeams },
  }).then(
    ({ error }: { error: unknown }) => {
      if (error) console.error("host_update_room_config" + " failed", error);
    },
    (e: unknown) => console.error("host_update_room_config" + " failed", e),
  );
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
  // .then() explícito: o builder é "thenable" e `void builder` NÃO dispara a request.
  (supabase.rpc as any)("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: { teams },
  }).then(
    ({ error }: { error: unknown }) => {
      if (error) console.error("host_update_room_config" + " failed", error);
    },
    (e: unknown) => console.error("host_update_room_config" + " failed", e),
  );
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
  (supabase.rpc as any)("assign_player_team", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_player_id: playerId,
    p_team_id: teamId ?? "",
  }).then(
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
    assignPlayerToTeam(roomId, actorId, p.id, teams[i % teams.length].id),
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
export async function applyWritingTimeoutOrAdvance(
  roomId: string,
): Promise<{ extended: boolean; kickedIds: string[] }> {
  const { data, error } = await supabase.rpc("extend_writing_or_advance", {
    p_room_id: roomId,
  });
  if (error) {
    console.error("extend_writing_or_advance failed", error);
    return { extended: false, kickedIds: [] };
  }
  const payload = (data ?? {}) as { action?: string; kicked?: string[] };
  return {
    extended: payload.action === "extended",
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
