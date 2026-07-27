// Fase 10 · parte 2 — contexto compartilhado do useRoom.
// O hook principal (use-room.ts) é o dono de TODO o estado; os módulos
// (data/realtime/optimistic/polling/presence) recebem este objeto e ligam
// seus efeitos. Nenhum módulo cria estado próprio — evita duplo-dono.
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Room, Player, Definition, Vote, Word } from "@/lib/room";
import type { RoundExtension } from "@/hooks/use-room";

export interface RoomCtx {
  code: string | undefined;
  playerId?: string;

  room: Room | null;
  setRoom: Dispatch<SetStateAction<Room | null>>;
  players: Player[];
  setPlayers: Dispatch<SetStateAction<Player[]>>;
  definitions: Definition[];
  setDefinitions: Dispatch<SetStateAction<Definition[]>>;
  votes: Vote[];
  setVotes: Dispatch<SetStateAction<Vote[]>>;
  word: Word | null;
  setWord: Dispatch<SetStateAction<Word | null>>;
  roundExtensions: RoundExtension[];
  setRoundExtensions: Dispatch<SetStateAction<RoundExtension[]>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setDegraded: Dispatch<SetStateAction<boolean>>;
  presenceMap: Record<string, boolean>;
  setPresenceMap: Dispatch<SetStateAction<Record<string, boolean>>>;

  /** Recarga completa via get_room_state — populada pelo módulo de dados. */
  reloadRef: MutableRefObject<() => Promise<void>>;
  /** id → timestamp de adds otimistas de jogador (bots) ainda não ecoados. */
  optimisticPlayerIdsRef: MutableRefObject<Record<string, number>>;
  /** Último evento realtime/poll recebido (poll adaptativo decide por ele). */
  lastEventAtRef: MutableRefObject<number>;
  /** Assinatura status|round|word conhecida — dedupe de broadcasts/polls. */
  lastRoomSigRef: MutableRefObject<string>;
  playersRef: MutableRefObject<Player[]>;
  roomRef: MutableRefObject<Room | null>;
}
