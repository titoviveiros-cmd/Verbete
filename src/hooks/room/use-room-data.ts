// Módulo: carga de dados — snapshot inicial via get_room_state (com
// fallback legado), refresh de definições/votos na virada de rodada e
// carregamento da palavra corrente (colunas seguras apenas — S1/S2).
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Room, Player, Definition, Vote, Word } from "@/lib/room";
import type { RoundExtension } from "@/hooks/use-room";
import type { RoomCtx } from "./ctx";

export function useRoomData(ctx: RoomCtx) {
  const {
    code,
    room,
    setRoom,
    setPlayers,
    setDefinitions,
    setVotes,
    setWord,
    setRoundExtensions,
    setLoading,
    setError,
    reloadRef,
    lastEventAtRef,
    lastRoomSigRef,
  } = ctx;
  const roomId = room?.id;
  const roomRound = room?.current_round;
  const currentWordId = room?.current_word_id;

  // Initial load — single RPC roundtrip
  useEffect(() => {
    if (!code) return;
    let alive = true;
    const load = async () => {
      const { data, error: rpcErr } = await supabase.rpc("get_room_state", {
        p_code: code,
      });
      if (!alive) return;
      if (!rpcErr && data) {
        const payload = data as unknown as {
          room: Room;
          players: Player[];
          definitions: Definition[];
          votes: Vote[];
          word: Word | null;
        };
        if (!payload?.room) {
          setError("Sala não encontrada");
          setLoading(false);
          return;
        }
        setRoom(payload.room);
        lastRoomSigRef.current = `${payload.room.status}|${payload.room.current_round}|${payload.room.current_word_id ?? ""}`;
        lastEventAtRef.current = Date.now();
        setPlayers((payload.players ?? []).filter((p) => !p.kicked_at));
        setDefinitions(payload.definitions ?? []);
        setVotes(payload.votes ?? []);
        setWord(payload.word ?? null);
        // round_extensions é carregado separadamente — não vem no RPC.
        supabase
          .from("round_extensions")
          .select("*")
          .eq("room_id", payload.room.id)
          .then(({ data }) => {
            if (alive)
              setRoundExtensions((data as unknown as RoundExtension[]) ?? []);
          });
        setLoading(false);
        return;
      }
      // Fallback legado (RPC indisponível)
      const { data: r, error: e } = await supabase
        .from("rooms")
        .select("*")
        .eq("code", code)
        .maybeSingle();
      if (!alive) return;
      if (e || !r) {
        setError(e?.message ?? "Sala não encontrada");
        setLoading(false);
        return;
      }
      setRoom(r as unknown as Room);
      const [{ data: ps }, { data: sync }, { data: rxs }] = await Promise.all([
        supabase
          .from("players")
          .select("*")
          .eq("room_id", r.id)
          .is("kicked_at", null)
          .order("joined_at"),
        supabase.rpc("get_round_sync", { p_room_id: r.id }),
        supabase.from("round_extensions").select("*").eq("room_id", r.id),
      ]);
      if (!alive) return;
      setPlayers((ps as unknown as Player[]) ?? []);
      const syncPayload = sync as {
        definitions?: Definition[];
        votes?: Vote[];
      } | null;
      setDefinitions(syncPayload?.definitions ?? []);
      setVotes(syncPayload?.votes ?? []);
      setRoundExtensions((rxs as unknown as RoundExtension[]) ?? []);
      setLoading(false);
    };
    reloadRef.current = load;
    load();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // When round changes, refresh definitions/votes.
  // CRÍTICO: limpamos o estado IMEDIATAMENTE antes do refetch para evitar
  // que arrays stale da rodada anterior disparem `allVoted` e façam o host
  // chamar `revealAndScore` prematuramente na rodada nova (bug que zerava
  // o placar inteiro).
  useEffect(() => {
    if (!roomId) return;
    setDefinitions([]);
    setVotes([]);
    (async () => {
      const { data: sync } = await supabase.rpc("get_round_sync", {
        p_room_id: roomId,
      });
      const payload = sync as {
        definitions?: Definition[];
        votes?: Vote[];
      } | null;
      setDefinitions(payload?.definitions ?? []);
      setVotes(payload?.votes ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, roomRound]);

  // Load current word
  useEffect(() => {
    if (!currentWordId) {
      setWord(null);
      return;
    }
    (async () => {
      // Colunas seguras apenas — meaning/curiosidade são bloqueadas por grants
      // e chegam via get_word_reveal() somente após a revelação.
      const { data } = await supabase
        .from("words")
        .select("id,word,category,rarity,nivel,classe,pronuncia")
        .eq("id", currentWordId)
        .maybeSingle();
      if (data) {
        setWord(data as unknown as Word);
        return;
      }
      const { data: cw } = await supabase
        .from("room_words")
        .select("id,word,meaning,category")
        .eq("id", currentWordId)
        .maybeSingle();
      if (cw) {
        const row = cw as {
          id: string;
          word: string;
          meaning: string;
          category: string | null;
        };
        setWord({
          id: row.id,
          word: row.word,
          meaning: row.meaning,
          category: row.category ?? "custom",
          rarity: 2,
        } as Word);
      } else {
        setWord(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWordId]);
}
