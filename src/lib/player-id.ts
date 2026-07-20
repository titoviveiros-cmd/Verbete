// ID local persistente do jogador (sem login).
const KEY = "verbete:player-id";

export function getPlayerId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id =
      "p_" +
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36).slice(-4);
    localStorage.setItem(KEY, id);
  }
  return id;
}

// S4: gera e persiste um NOVO id local. Usado quando o servidor responde
// 'player_id_taken' (o id guardado pertence a outra identidade auth).
export function regeneratePlayerId(): string {
  const id =
    "p_" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36).slice(-4);
  if (typeof window !== "undefined") localStorage.setItem(KEY, id);
  return id;
}

// Force-set the local player id (used to restore a host identity when
// re-entering a room they created in a previous session/tab).
export function setPlayerId(id: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, id);
}

export function getStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem("verbete:" + key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function setStored<T>(key: string, val: T) {
  if (typeof window === "undefined") return;
  localStorage.setItem("verbete:" + key, JSON.stringify(val));
}
