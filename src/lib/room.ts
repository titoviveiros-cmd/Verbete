import { supabase } from "@/integrations/supabase/client";
import { sanitizeDefinition, sanitizeNickname, humanizeMeaning } from "./text-filter";
import { BOT_NAMES, BOT_FAKE_DEFINITIONS_TEMPLATES, randomBotDef } from "./bot-names";
import { randomAvatar, randomColor } from "./avatars";

export type RoomStatus =
  | "lobby" | "choosing" | "writing" | "shuffling"
  | "voting" | "reveal" | "scoreboard" | "finished";

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
  "ab": [
    { id: "a", name: "Time A", color: "#FFD166", emoji: "🅰️" },
    { id: "b", name: "Time B", color: "#06D6A0", emoji: "🅱️" },
  ],
  "abc": [
    { id: "a", name: "Time A", color: "#FFD166", emoji: "🅐" },
    { id: "b", name: "Time B", color: "#06D6A0", emoji: "🅑" },
    { id: "c", name: "Time C", color: "#EF476F", emoji: "🅒" },
  ],
};

export interface Word {
  id: string;
  word: string;
  meaning: string;
  category: string | null;
  rarity: number;
}

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

export const isTruthDef = (d: Pick<Definition, "player_id">) => d.player_id === "__truth__";

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

export async function createRoom(hostId: string, nickname: string, avatar: string, color: string) {
  // Single-RPC creation (rooms+player insert in one transaction). Falls back to legacy path on error.
  const cleanNick = sanitizeNickname(nickname);
  const { data, error } = await (supabase.rpc as any)("create_room_with_host", {
    p_host_id: hostId,
    p_nickname: cleanNick,
    p_avatar: avatar,
    p_color: color,
  });
  if (!error && data) return data as Room;

  // Fallback (RPC unavailable)
  let code = genCode();
  for (let i = 0; i < 5; i++) {
    const { data: existing } = await supabase.from("rooms").select("id").eq("code", code).maybeSingle();
    if (!existing) break;
    code = genCode();
  }
  const { data: room, error: roomErr } = await supabase
    .from("rooms").insert({ code, host_id: hostId, status: "lobby" }).select().single();
  if (roomErr || !room) throw roomErr ?? new Error("create_failed");
  await supabase.from("players").insert({
    id: hostId, room_id: room.id, nickname: cleanNick, avatar, color,
  });
  return room as unknown as Room;
}

export async function joinRoom(code: string, playerId: string, nickname: string, avatar: string, color: string) {
  const { data: room, error } = await supabase
    .from("rooms").select("*").eq("code", code).maybeSingle();
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
    throw new Error("Esta conta ou dispositivo foi banido por violar as regras da comunidade.");
  }

  const cleanNick = sanitizeNickname(nickname);

  // Usa rejoin_room: se o jogador existir (mesmo kicked_at), preserva
  // a pontuação acumulada e zera apenas os contadores de penalidade.
  const { error: rpcErr } = await (supabase.rpc as any)("rejoin_room", {
    p_code: code,
    p_player_id: playerId,
    p_nickname: cleanNick,
    p_avatar: avatar,
    p_color: color,
  });
  if (rpcErr) {
    // Fallback legado
    await supabase.from("players").upsert({
      id: playerId, room_id: room.id, nickname: cleanNick, avatar, color, is_connected: true,
    });
  }
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
  if (error) { console.error("migrateHost failed", error); return false; }
  return !!data;
}

export async function kickPlayer(roomId: string, actorId: string, playerId: string) {
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
    window.dispatchEvent(new CustomEvent("player:optimistic-remove", { detail: { playerId: id } }));
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
        detail: { roomId, patch: { win_condition: condition, win_target: target } },
      }),
    );
  }
  void (supabase.rpc as any)("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: { win_condition: condition, win_target: target },
  });
}

// ---------- Game flow (driven by host browser) ----------

export async function fetchThreeWords(
  excludeIds: string[] = [],
  categories: string[] = [],
  roomId?: string,
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
    const { data, error } = await (supabase.rpc as any)("get_random_words", {
      exclude_ids: excludeIds,
      min_rarity: 2,
      lim: needed,
      p_categories: categories,
    });
    if (!error && data && data.length >= needed) {
      globalPool = data as Word[];
    } else if (categories.length > 0) {
      const { data: any3 } = await (supabase.rpc as any)("get_random_words", {
        exclude_ids: excludeIds, min_rarity: 2, lim: needed,
      });
      if (any3) globalPool = any3 as Word[];
    }
    if (globalPool.length < needed) {
      let q = supabase.from("words").select("*").limit(120);
      if (excludeIds.length) q = q.not("id", "in", `(${excludeIds.join(",")})`);
      if (categories.length) q = q.in("category", categories);
      const { data: anyN } = await q;
      globalPool = shuffle(anyN ?? []).slice(0, needed) as Word[];
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

export async function addRoomWord(roomId: string, playerId: string, word: string, meaning: string) {
  const cleanWord = word.trim().slice(0, 40);
  const cleanMeaning = meaning.trim().slice(0, 220);
  if (!cleanWord || !cleanMeaning) return null;
  const { data, error } = await supabase
    .from("room_words")
    .insert({ room_id: roomId, created_by: playerId, word: cleanWord, meaning: cleanMeaning })
    .select()
    .single();
  if (error) return null;
  return data as RoomWord;
}

export async function deleteRoomWord(id: string) {
  await supabase.from("room_words").delete().eq("id", id);
}

export async function setCategories(roomId: string, actorId: string, categories: string[]) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { categories } },
      }),
    );
  }
  void (supabase.rpc as any)("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: { categories },
  });
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stableRoundHash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function stableRoundShuffle<T extends { id: string }>(arr: T[], seed: string): T[] {
  return [...arr].sort(
    (a, b) => stableRoundHash(`${seed}:${a.id}`) - stableRoundHash(`${seed}:${b.id}`),
  );
}

async function fetchRoundDefinitions(roomId: string, round: number): Promise<Definition[]> {
  const { data } = await supabase
    .from("definitions")
    .select("id,room_id,round,player_id,text,letter")
    .eq("room_id", roomId)
    .eq("round", round);
  return (data as Definition[]) ?? [];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startGame(room: Room, players: Player[]) {
  const resetPlayers = players.map((p) => ({ ...p, score: 0, coordinator_count: 0 }));
  const next = pickNextCoordinator(resetPlayers, null);
  // Otimismo: já transita a sala para "choosing" localmente para a UI sair
  // do lobby instantaneamente. Os resets de tabelas (players/defs/votes/rounds)
  // rodam em paralelo em segundo plano.
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
  // Dispara resets em paralelo (fire-and-forget) e AGUARDA o update da sala —
  // este é o evento canônico que destrava a transição para os demais clientes
  // via realtime. Se ficar fire-and-forget e falhar (rede instável, RLS),
  // só o host transita (pelo otimismo) e os outros ficam presos no lobby.
  supabase.from("players").update({ score: 0, coordinator_count: 0, writing_extensions: 0, voting_extensions: 0 }).eq("room_id", room.id).then(() => {}, () => {});
  supabase.from("definitions").delete().eq("room_id", room.id).then(() => {}, () => {});
  supabase.from("votes").delete().eq("room_id", room.id).then(() => {}, () => {});
  supabase.from("rounds").delete().eq("room_id", room.id).then(() => {}, () => {});
  await supabase
    .from("rooms")
    .update({
      status: "choosing",
      current_round: 1,
      current_coordinator: next.id,
      current_word_id: null,
    })
    .eq("id", room.id);
}

function pickNextCoordinator(players: Player[], lastCoord: string | null): Player {
  // Prefer players with the lowest coordinator_count, exclude last
  const candidates = players.filter((p) => p.id !== lastCoord);
  const pool = candidates.length > 0 ? candidates : players;
  const minCount = Math.min(...pool.map((p) => p.coordinator_count));
  const tier = pool.filter((p) => p.coordinator_count === minCount);
  return tier[Math.floor(Math.random() * tier.length)];
}

export async function chooseWord(roomId: string, wordId: string, durationSec = 60) {
  const ends = new Date(Date.now() + durationSec * 1000).toISOString();
  // Só permite escolher palavra enquanto a sala estiver na fase "choosing".
  const { data: r } = await supabase
    .from("rooms")
    .select("used_word_ids,status,current_word_id")
    .eq("id", roomId)
    .maybeSingle();
  if (!r || (r as any).status !== "choosing" || (r as any).current_word_id) return;
  const used = ((r as any)?.used_word_ids as string[] | null) ?? [];
  const nextUsed = used.includes(wordId) ? used : [...used, wordId];
  // Otimismo: transita para "writing" imediatamente para o coordenador e
  // demais clientes que estiverem ouvindo o evento. O realtime ainda traz
  // o estado canônico em seguida.
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
            used_word_ids: nextUsed,
          },
        },
      }),
    );
  }
  await supabase
    .from("rooms")
    .update({
      status: "writing",
      current_word_id: wordId,
      round_phase_ends_at: ends,
      phase_started_at: new Date().toISOString(),
      used_word_ids: nextUsed,
    })
    .eq("id", roomId)
    .eq("status", "choosing"); // guarda atômica contra corrida
}

export class DuplicateDefinitionError extends Error {
  constructor(message = "Já existe uma definição igual a essa nesta rodada. Reescreva com suas próprias palavras.") {
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

export async function submitDefinition(roomId: string, round: number, playerId: string, text: string, isTruth = false, word?: string) {
  // Passa a palavra-alvo para o sanitizer detectar tentativas de "colar a resposta"
  // mesmo com acento/maiúscula/separadores que sobreviveriam à normalização básica.
  const clean = sanitizeDefinition(text, 140, isTruth ? undefined : word);

  // Dedup: jogadores humanos não podem enviar uma definição idêntica
  // (após normalização) a outra já submetida na mesma rodada — inclusive
  // a definição verdadeira. Bots usam sua própria dedup interna.
  if (!isTruth) {
    const key = normalizeDefText(clean);
    if (key.length > 0) {
      const { data: existing } = await supabase
        .from("definitions")
        .select("text, player_id")
        .eq("room_id", roomId)
        .eq("round", round);
      const clash = (existing ?? []).some(
        (d) => d.player_id !== playerId && normalizeDefText(String(d.text ?? "")) === key,
      );
      if (clash) throw new DuplicateDefinitionError();
    }
  }

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
            id: pendingId, room_id: roomId, round, player_id: playerId,
            text: clean, letter: null, is_truth: false,
          },
        },
      }),
    );
  }
  try {
    if (isTruth) {
      // Definição verdadeira (chamada pelo host na transição p/ votação)
      const { data, error } = await (supabase.rpc as any)("insert_truth_definition", {
        p_room_id: roomId, p_round: round, p_text: clean,
      });
      if (error) throw error;
      if (data && (data as any).ok === false) {
        throw new Error(`insert_truth_definition rejected: ${(data as any).reason}`);
      }
    } else {
      const { data, error } = await (supabase.rpc as any)("submit_definition", {
        p_room_id: roomId, p_player_id: playerId, p_text: clean,
      });
      if (error) throw error;
      if (data && (data as any).ok === false) {
        throw new Error(`submit_definition rejected: ${(data as any).reason}`);
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
  "TioBlefe": "giria",
  "MestreLero": "poetico",
  "Dona Lupa": "formal",
  "Zé Tagarela": "regional",
  "Profa. Trapaça": "tecnico",
  "Dr. Engano": "tecnico",
  "Vó Vera": "pratico",
  "Caco Esperto": "giria",
};
const PERSONA_POOL = ["formal", "giria", "tecnico", "regional", "poetico", "pratico"];
function personaFor(bot: Player, idx: number): string {
  return BOT_PERSONA_BY_NAME[bot.nickname] ?? PERSONA_POOL[idx % PERSONA_POOL.length];
}

export async function botSubmitDefinitions(
  roomId: string, round: number, bots: Player[], word?: Word | null,
) {
  if (bots.length === 0) return;
  const delay = 1500 + Math.random() * 2500;

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
      if (Array.isArray(arr)) aiDefs = arr.filter((s) => typeof s === "string" && s.length > 5);
    } catch (e) {
      console.warn("bot-definitions AI failed, using fallback", e);
    }
  }

  setTimeout(async () => {
    // Dedup: bots NUNCA devem dar a mesma resposta (entre si, igual à verdade,
    // ou igual a uma definição já enviada por qualquer outro jogador humano).
    const norm = (s: string) =>
      s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
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
    const fallbackPool = [...BOT_FAKE_DEFINITIONS_TEMPLATES].sort(() => Math.random() - 0.5);
    let fbIdx = 0;
    const nextFallback = (): string => {
      for (let k = 0; k < fallbackPool.length; k++) {
        const cand = fallbackPool[(fbIdx + k) % fallbackPool.length];
        if (!used.has(norm(cand))) { fbIdx = (fbIdx + k + 1) % fallbackPool.length; return cand; }
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
    }).then(() => {}, () => {});
  }, delay);
}

// Gera UMA definição falsa no mesmo estilo dos bots, para o jogador humano
// usar como "auto" caso não queira digitar. Usa a edge function de bots
// (mesma IA + mesmas regras gramaticais), com fallback local.
export async function generateAiDefinitionForPlayer(word: Word): Promise<string> {
  const personas = ["formal", "giria", "tecnico", "regional", "poetico", "pratico"];
  const persona = personas[Math.floor(Math.random() * personas.length)];
  try {
    const { data } = await supabase.functions.invoke("bot-definitions", {
      body: { word_id: word.id, count: 1, personas: [persona] },
    });
    const arr = (data as any)?.definitions;
    const raw = Array.isArray(arr) ? arr.find((s: unknown) => typeof s === "string" && (s as string).length > 5) : null;
    if (raw) return sanitizeDefinition(raw as string, 140, word.word);
  } catch (e) {
    console.warn("generateAiDefinitionForPlayer failed, using fallback", e);
  }
  const fb = BOT_FAKE_DEFINITIONS_TEMPLATES[Math.floor(Math.random() * BOT_FAKE_DEFINITIONS_TEMPLATES.length)];
  return sanitizeDefinition(fb, 140, word.word);
}

export async function startShuffling(roomId: string): Promise<boolean> {
  // Guarda atômica: só promove se ainda estiver em "writing" e o banco aceitar
  // a mudança. A UI otimista só roda DEPOIS do update real para não pular a
  // penalidade/prorrogação quando ainda há humano sem definição.
  const { data, error } = await supabase
    .from("rooms")
    .update({ status: "shuffling" })
    .eq("id", roomId)
    .eq("status", "writing")
    .select("id,status")
    .maybeSingle();
  if (error || data?.status !== "shuffling") return false;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { status: "shuffling" } },
      }),
    );
  }
  return true;
}

export async function startVoting(roomId: string, round: number, word: Word, defs: Definition[]) {
  const ends = new Date(Date.now() + 40 * 1000).toISOString();
  const phaseStart = new Date().toISOString();
  const [{ data: roomSnapshot }, { data: roomPlayers }] = await Promise.all([
    supabase.from("rooms").select("status,current_round,current_coordinator").eq("id", roomId).maybeSingle(),
    supabase.from("players").select("id, kicked_at").eq("room_id", roomId).is("kicked_at", null),
  ]);
  const currentRoom = roomSnapshot as { status?: RoomStatus; current_round?: number; current_coordinator?: string | null } | null;
  if (!currentRoom || currentRoom.current_round !== round || !["shuffling", "voting"].includes(currentRoom.status ?? "")) return;
  const expectedWriters = ((roomPlayers as { id: string }[] | null) ?? [])
    .filter((p) => p.id !== currentRoom.current_coordinator)
    .length;

  // Fecha a janela entre o envio otimista e a linha real no banco. Sem isso,
  // a votação podia abrir com a última definição sem letra e parecer travada.
  for (let tries = 0; tries < 8; tries++) {
    const realDefs = await fetchRoundDefinitions(roomId, round);
    const realWriters = realDefs.filter((d) => !isTruthDef(d)).length;
    if (expectedWriters === 0 || realWriters >= expectedWriters) break;
    await wait(250);
  }
  let allDefs = defs.filter((d) => d.round === round);
  if (!allDefs.some(isTruthDef)) {
    const { data: truthRes, error: truthErr } = await (supabase.rpc as any)(
      "insert_truth_definition",
      { p_room_id: roomId, p_round: round, p_text: humanizeMeaning(word.meaning) },
    );
    if (!truthErr && truthRes && (truthRes as any).ok && (truthRes as any).id) {
      // Recarrega após RPC para puxar a linha completa
      const refreshed = await fetchRoundDefinitions(roomId, round);
      allDefs = refreshed;
    }
  }

  allDefs = await fetchRoundDefinitions(roomId, round);
  const shuffled = stableRoundShuffle(allDefs, `${roomId}:${round}`);
  const letters = "ABCDEFGHIJKLM";
  await Promise.all(
    shuffled.map((d, i) =>
      supabase.from("definitions").update({ letter: letters[i] }).eq("id", d.id),
    ),
  );

  const { data: updatedRoom } = await supabase
    .from("rooms")
    .update({ status: "voting", round_phase_ends_at: ends, phase_started_at: phaseStart })
    .eq("id", roomId)
    .eq("current_round", round)
    .in("status", ["shuffling", "voting"])
    .select("id,status")
    .maybeSingle();
  if (updatedRoom?.status !== "voting") return;

  if (typeof window !== "undefined") {
    const patchedDefinitions = shuffled.map((d, i) => ({ ...d, letter: letters[i] }));
    window.dispatchEvent(
      new CustomEvent("definitions:optimistic-replace-round", {
        detail: { roomId, round, definitions: patchedDefinitions },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { status: "voting", round_phase_ends_at: ends, phase_started_at: phaseStart } },
      }),
    );
  }
}

export async function castVote(roomId: string, round: number, voterId: string, definitionId: string) {
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
            id: pendingId, room_id: roomId, round,
            voter_id: voterId, definition_id: definitionId,
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

export async function botsVote(roomId: string, round: number, bots: Player[], defs: Definition[]) {
  if (bots.length === 0) return;
  const delay = 2000 + Math.random() * 3000;
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
    }).then(() => {}, () => {});
  }, delay);
}

export async function revealAndScore(
  room: Room, players: Player[], defs: Definition[], votes: Vote[], coordinatorId: string,
): Promise<boolean> {
  // Guarda final contra clientes com estado local atrasado: antes de revelar,
  // confirma no banco que não existe humano elegível sem voto. Se existir, a
  // própria RPC de timeout aplica a prorrogação/remoção e esta chamada aborta.
  if (room.status === "voting") {
    const [{ data: liveRoom }, { data: livePlayers }, { data: liveVotes }] = await Promise.all([
      supabase
        .from("rooms")
        .select("status,current_round,phase_started_at")
        .eq("id", room.id)
        .maybeSingle(),
      supabase
        .from("players")
        .select("id,joined_at,is_bot,kicked_at")
        .eq("room_id", room.id)
        .is("kicked_at", null),
      supabase
        .from("votes")
        .select("voter_id")
        .eq("room_id", room.id)
        .eq("round", room.current_round),
    ]);
    const current = liveRoom as Pick<Room, "status" | "current_round" | "phase_started_at"> | null;
    if (current?.status !== "voting" || current.current_round !== room.current_round) return true;
    const votedIds = new Set(((liveVotes as Pick<Vote, "voter_id">[] | null) ?? []).map((v) => v.voter_id));
    const phaseStartMs = current.phase_started_at ? new Date(current.phase_started_at).getTime() : null;
    const hasPendingHuman = ((livePlayers as Pick<Player, "id" | "joined_at" | "is_bot">[] | null) ?? []).some((p) => {
      if (p.is_bot || votedIds.has(p.id)) return false;
      if (phaseStartMs === null) return true;
      return new Date(p.joined_at).getTime() <= phaseStartMs + 3000;
    });
    if (hasPendingHuman) {
      await applyVotingTimeoutOrAdvance(room.id);
      return false;
    }
  }

  // Defensive guard: never insert a rounds row (and mark a round as scored)
  // when there are zero votes but real definitions exist. The server cron has
  // the same guard and will eventually score the round when votes arrive.
  if (votes.length === 0) {
    const { count: defsCount } = await supabase
      .from("definitions")
      .select("id", { count: "exact", head: true })
      .eq("room_id", room.id)
      .eq("round", room.current_round)
      .neq("player_id", "__truth__");
    if ((defsCount ?? 0) > 0) return false;
  }

  // Idempotency guard: insert into rounds with UNIQUE(room_id, round).
  // If another client already scored this round, the insert fails and we exit.
  const { error: roundsErr } = await supabase.from("rounds").insert({
    room_id: room.id,
    round: room.current_round,
    coordinator_id: coordinatorId,
    word_id: room.current_word_id,
  });
  if (roundsErr) {
    // Already scored — just ensure status is reveal and return.
    await supabase.from("rooms").update({ status: "reveal" }).eq("id", room.id);
    return true;
  }

  // PERFORMANCE: muda o status para "reveal" IMEDIATAMENTE para que todos os
  // clientes transitem para a tela de revelação sem esperar a edge function
  // de similaridade (que chama um LLM e pode demorar vários segundos). A
  // pontuação prossegue em background; a tela de revelação tem 30s antes
  // de avançar para o placar, tempo suficiente para os updates de score
  // chegarem via realtime.
  await supabase.from("rooms").update({ status: "reveal" }).eq("id", room.id);

  // Recarrega snapshots frescos do banco — o estado realtime do host pode
  // estar atrasado em relação aos últimos votos/definições (inclusive o
  // próprio voto do host disparado milissegundos antes), o que fazia
  // pontos sumirem. Como já passamos pela guarda de idempotência acima,
  // somos o único cliente pontuando esta rodada.
  const [{ data: freshDefs }, { data: freshVotes }, { data: freshPlayers }] = await Promise.all([
    supabase.from("definitions").select("*").eq("room_id", room.id).eq("round", room.current_round),
    supabase.from("votes").select("*").eq("room_id", room.id).eq("round", room.current_round),
    supabase.from("players").select("*").eq("room_id", room.id),
  ]);
  defs = (freshDefs as Definition[]) ?? defs;
  votes = (freshVotes as Vote[]) ?? votes;
  players = (freshPlayers as Player[]) ?? players;

  // Score:
  //  - voted truth: +3 to voter
  //  - each vote on your fake def: +1 to def author
  //  - your fake def é semanticamente ≥80% equivalente à verdadeira: +3 ao autor
  //  - coordinator: +2 if nobody voted truth
  const truthDef = defs.find(isTruthDef);
  const truthVoters = votes.filter((v) => v.definition_id === truthDef?.id).map((v) => v.voter_id);

  const updates = new Map<string, number>();
  const add = (id: string, n: number) => updates.set(id, (updates.get(id) ?? 0) + n);

  for (const voter of truthVoters) add(voter, 3);

  for (const def of defs) {
    if (isTruthDef(def)) continue;
    const count = votes.filter((v) => v.definition_id === def.id).length;
    if (count > 0) add(def.player_id, count);
  }

  // Bônus de equivalência semântica (≥80%) — chama edge function de IA.
  // Falhas são silenciosas (apenas perde-se o bônus desta rodada).
  const fakeDefs = defs.filter((d) => !isTruthDef(d));
  if (truthDef && fakeDefs.length > 0 && room.current_word_id) {
    try {
      const { data: simData } = await supabase.functions.invoke("score-similarity", {
        body: {
          room_id: room.id,
          round: room.current_round,
          candidates: fakeDefs.map((d) => ({ id: d.id, text: d.text })),
        },
      });
      const matches: string[] = Array.isArray((simData as any)?.matches) ? (simData as any).matches : [];
      if (matches.length > 0) {
        const matchSet = new Set(matches);
        await supabase.from("definitions").update({ near_truth: true }).in("id", matches);
        for (const d of fakeDefs) if (matchSet.has(d.id)) add(d.player_id, 3);
      }
    } catch (e) {
      console.error("similarity check failed", e);
    }
  }

  if (truthVoters.length === 0) add(coordinatorId, 2);

  // NOTA: a penalidade de -1 por prorrogação NÃO é aplicada aqui —
  // as RPCs `extend_writing_or_advance` / `extend_voting_or_advance`
  // já debitam `score = GREATEST(score-1, 0)` no exato momento em que
  // a prorrogação acontece. Aplicar de novo aqui causava dedução dupla
  // (o breakdown do Scoreboard mostra a penalidade uma única vez, que
  // é o valor real já debitado no banco).

  // Coordinator count++
  await supabase.from("players")
    .update({ coordinator_count: (players.find((p) => p.id === coordinatorId)?.coordinator_count ?? 0) + 1 })
    .eq("id", coordinatorId);

  // Apply score updates
  await Promise.all(
    Array.from(updates.entries()).map(([pid, delta]) => {
      const p = players.find((pp) => pp.id === pid);
      if (!p) return Promise.resolve();
      return supabase.from("players")
        .update({ score: p.score + delta })
        .eq("id", pid);
    })
  );

  // status já foi setado para "reveal" no início da função (após o insert
  // idempotente em rounds). Não repetimos aqui.
  return true;
}

export async function goToScoreboard(roomId: string) {
  await supabase.from("rooms").update({ status: "scoreboard" }).eq("id", roomId);
}

// Decide se vai pro placar da rodada ou direto pro fim de jogo
// (quando alguém atingiu a pontuação alvo escolhida pelo criador da sala).
export async function advanceAfterReveal(room: Room, players: Player[]) {
  // Usa placar fresco do banco: o status "reveal" pode chegar por realtime
  // antes das atualizações de pontos chegarem em todos os clientes.
  const { data: freshPlayers } = await supabase
    .from("players")
    .select("id,score,team_id")
    .eq("room_id", room.id);
  const fresh = (freshPlayers ?? []) as { id: string; score: number; team_id: string | null }[];
  const isTeams = room.mode === "teams" && (room.teams?.length ?? 0) > 0;
  let maxScore: number;
  if (isTeams) {
    const totals = (room.teams ?? []).map((t) =>
      fresh.filter((p) => p.team_id === t.id).reduce((s, p) => s + (p.score ?? 0), 0)
    );
    maxScore = Math.max(0, ...totals);
  } else {
    const scores = fresh.length ? fresh.map((p) => p.score ?? 0) : players.map((p) => p.score);
    maxScore = Math.max(0, ...scores);
  }
  const reachedTarget =
    room.win_condition === "score" && maxScore >= room.win_target;
  const status: RoomStatus = reachedTarget ? "finished" : "scoreboard";
  await supabase.from("rooms").update({ status }).eq("id", room.id);
}

export async function nextRound(room: Room, players: Player[]) {
  // Check win condition (em modo equipes, soma pontos por time).
  const isTeams = room.mode === "teams" && (room.teams?.length ?? 0) > 0;
  const maxScore = isTeams
    ? Math.max(
        0,
        ...(room.teams ?? []).map((t) =>
          players.filter((p) => p.team_id === t.id).reduce((s, p) => s + (p.score ?? 0), 0)
        )
      )
    : Math.max(0, ...players.map((p) => p.score));
  const everyoneCoordinatedTwice = players.every((p) => p.coordinator_count >= 2);

  const won =
    (room.win_condition === "score" && maxScore >= room.win_target) ||
    (room.win_condition === "rounds" && everyoneCoordinatedTwice);

  if (won) {
    await supabase.from("rooms").update({ status: "finished" }).eq("id", room.id);
    return;
  }

  const next = pickNextCoordinator(players, room.current_coordinator);
  // writing_extensions acumula durante a partida inteira:
  // 3 rodadas sem enviar definição = jogador removido.
  await supabase.from("rooms").update({
    status: "choosing",
    current_round: room.current_round + 1,
    current_coordinator: next.id,
    current_word_id: null,
    round_phase_ends_at: null,
  }).eq("id", room.id);
}

export async function restartGame(roomId: string) {
  // Single-transaction reset via server RPC
  const { error } = await supabase.rpc("reset_room", { p_room_id: roomId });
  if (!error) return;
  // Fallback (RPC unavailable): legacy sequential reset
  const { data: ps } = await supabase.from("players").select("id").eq("room_id", roomId);
  if (ps) {
    await Promise.all(
      ps.map((p) =>
        supabase.from("players").update({ score: 0, coordinator_count: 0, writing_extensions: 0, voting_extensions: 0 }).eq("id", p.id)
      )
    );
  }
  await Promise.all([
    supabase.from("definitions").delete().eq("room_id", roomId),
    supabase.from("votes").delete().eq("room_id", roomId),
    supabase.from("rounds").delete().eq("room_id", roomId),
  ]);
  // IMPORTANT: do NOT clear used_word_ids — palavras já usadas continuam excluídas mesmo após reiniciar
  await supabase.from("rooms").update({
    status: "lobby", current_round: 0,
    current_coordinator: null, current_word_id: null, round_phase_ends_at: null,
  }).eq("id", roomId);
}

export async function sendReaction(roomId: string, playerId: string, emoji: string) {
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
export async function setRoomMode(roomId: string, actorId: string, mode: RoomMode, teams: Team[] = []) {
  const nextTeams = mode === "teams" ? teams : [];
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { mode, teams: nextTeams } },
      }),
    );
    if (mode === "individual") {
      window.dispatchEvent(
        new CustomEvent("players:optimistic-clear-team", { detail: { roomId } }),
      );
    }
  }
  // RPC já zera team_id de todos quando mode='individual'.
  void (supabase.rpc as any)("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: { mode, teams: nextTeams },
  });
}

export async function setRoomTeams(roomId: string, actorId: string, teams: Team[]) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("room:optimistic-update", {
        detail: { roomId, patch: { teams } },
      }),
    );
  }
  void (supabase.rpc as any)("host_update_room_config", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_patch: { teams },
  });
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
  void (supabase.rpc as any)("assign_player_team", {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_player_id: playerId,
    p_team_id: teamId ?? "",
  });
}

export async function autoBalanceTeams(roomId: string, actorId: string, players: Player[], teams: Team[]) {
  if (!teams.length) return;
  // Distribui em round-robin pelos times (ordem aleatória)
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  shuffled.forEach((p, i) => assignPlayerToTeam(roomId, actorId, p.id, teams[i % teams.length].id));
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
  roomId: string
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
export async function applyVotingTimeoutOrAdvance(
  roomId: string
): Promise<{ action: string; extended: boolean; advanced: boolean; kickedIds: string[] }> {
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




