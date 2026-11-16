import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomCtx } from "@/hooks/room/ctx";
import type { Player, Room } from "@/lib/room";

// Privacidade das salas — fase 2 (migration 20261112120000). O servidor
// garante (scripts/test-privacidade-fase2.mjs na CI, com PostgREST e Realtime
// reais); aqui: o app novo assina os canais PRIVADOS, só depois de entrar, e
// o texto da migration/rollback.
const channels: Array<{
  topic: string;
  opts: unknown;
  subscribed: boolean;
  removed: boolean;
}> = [];
const getSession = vi.fn();
vi.mock("@/integrations/supabase/client", () => {
  const mk = (topic: string, opts: unknown) => {
    const rec = { topic, opts, subscribed: false, removed: false };
    channels.push(rec);
    const ch = {
      __rec: rec,
      on: () => ch,
      subscribe: () => {
        rec.subscribed = true;
        return ch;
      },
      send: () => Promise.resolve("ok"),
      track: () => Promise.resolve("ok"),
      presenceState: () => ({}),
    };
    return ch;
  };
  return {
    supabase: {
      channel: (topic: string, opts?: unknown) => mk(topic, opts),
      removeChannel: (ch: { __rec: { removed: boolean } }) => {
        ch.__rec.removed = true;
        return Promise.resolve("ok");
      },
      auth: { getSession: () => getSession() },
    },
  };
});
vi.mock("@/lib/ops", () => ({ reportOpsEvent: vi.fn() }));

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MIG = read("supabase/migrations/20261112120000_privacidade_fase2.sql");
const RB = read("supabase/rollback/privacidade_fase2.sql");
const TABLES = [
  "players",
  "votes",
  "reactions",
  "round_extensions",
  "rounds",
  "room_messages",
  "room_words",
];
const OLD: Record<string, string> = {
  players: "public read players",
  votes: "public read votes",
  reactions: "public read reactions",
  round_extensions: "round_extensions public read",
  rounds: "rounds open select",
  room_messages: "room_messages public read",
  room_words: "room_words public read",
};
const RPCS: Record<string, string> = {
  get_round_sync: "NULL",
  get_ballot: "'[]'::jsonb",
  get_room_definitions: "'[]'::jsonb",
  get_room_reveal: "jsonb_build_object('available', false)",
  get_round_reveal: "jsonb_build_object('available', false)",
  get_word_reveal: "NULL",
};

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
function ctx(players: Partial<Player>[], playerId = "eu"): RoomCtx {
  const ref = <T,>(v: T) => ({ current: v });
  const noop = () => {};
  return {
    code: "4321",
    playerId,
    room: { id: ROOM_ID, status: "lobby", current_round: 0 } as Room,
    setRoom: noop,
    players: players as Player[],
    setPlayers: noop,
    definitions: [],
    setDefinitions: noop,
    votes: [],
    setVotes: noop,
    word: null,
    setWord: noop,
    roundExtensions: [],
    setRoundExtensions: noop,
    setLoading: noop,
    setError: noop,
    setDegraded: noop,
    presenceMap: {},
    setPresenceMap: noop,
    reloadRef: ref(async () => {}),
    roundSyncRef: ref(null),
    optimisticPlayerIdsRef: ref({}),
    lastEventAtRef: ref(Date.now()),
    lastRoomSigRef: ref(""),
    playersRef: ref([]),
    roomRef: ref(null),
  } as unknown as RoomCtx;
}

afterEach(() => {
  channels.length = 0;
  getSession.mockReset();
});

describe("canal da sala (use-room-realtime)", () => {
  it("na tela de convite (não participa) NÃO assina; ao entrar assina room:<id> PRIVADO", async () => {
    const { useRoomRealtime } = await import("@/hooks/room/use-room-realtime");
    const { rerender } = renderHook(({ c }) => useRoomRealtime(c), {
      initialProps: { c: ctx([{ id: "outro" }]) },
    });
    expect(channels).toHaveLength(0);
    rerender({ c: ctx([{ id: "outro" }, { id: "eu" }]) });
    expect(channels).toHaveLength(1);
    expect(channels[0]!.topic).toBe(`room:${ROOM_ID}`);
    expect(channels[0]!.opts).toMatchObject({ config: { private: true } });
    expect(channels[0]!.subscribed).toBe(true);
  });

  it("expulso/removido (some da lista): sai do canal", async () => {
    const { useRoomRealtime } = await import("@/hooks/room/use-room-realtime");
    const { rerender } = renderHook(({ c }) => useRoomRealtime(c), {
      initialProps: { c: ctx([{ id: "eu" }]) },
    });
    expect(channels).toHaveLength(1);
    rerender({ c: ctx([{ id: "outro" }]) });
    expect(channels[0]!.removed).toBe(true);
    expect(channels).toHaveLength(1);
  });
});

describe("canais auxiliares", () => {
  it("reações: reactions:<id> PRIVADO", async () => {
    const { ReactionsLayer } = await import("@/components/ReactionsLayer");
    render(<ReactionsLayer roomId={ROOM_ID} playerId="eu" />);
    expect(channels[0]!.topic).toBe(`reactions:${ROOM_ID}`);
    expect(channels[0]!.opts).toMatchObject({ config: { private: true } });
  });

  it("latência: canal PRIVADO da própria sessão (nunca latency-<código>)", async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: "uid-1" } } },
    });
    const { LatencyIndicator } = await import("@/components/LatencyIndicator");
    render(<LatencyIndicator code="4321" />);
    await waitFor(() => expect(channels).toHaveLength(1));
    expect(channels[0]!.topic).toBe("latency:uid-1");
    expect(channels[0]!.opts).toMatchObject({
      config: { private: true, broadcast: { ack: true } },
    });
  });

  it("latência sem sessão: não assina nada", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const { LatencyIndicator } = await import("@/components/LatencyIndicator");
    render(<LatencyIndicator code="4321" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(channels).toHaveLength(0);
  });

  it("nenhum canal do app usa o tópico público antigo latency-<código>", () => {
    for (const f of [
      "src/components/LatencyIndicator.tsx",
      "src/components/ReactionsLayer.tsx",
      "src/hooks/room/use-room-realtime.ts",
    ]) {
      expect(read(f)).not.toMatch(/channel\(`latency-/);
    }
  });
});

describe("migration 20261112120000 (texto)", () => {
  it("as 7 tabelas: some o SELECT público e fica só participante (authenticated)", () => {
    for (const t of TABLES) {
      expect(MIG).toContain(
        `DROP POLICY IF EXISTS "${OLD[t]}" ON public.${t};`,
      );
      expect(MIG).toContain(
        `CREATE POLICY "${t} participantes leem" ON public.${t}\n  FOR SELECT TO authenticated\n  USING (room_id IN (SELECT public.my_room_ids()));`,
      );
    }
    expect(MIG).not.toMatch(/CREATE POLICY[^;]*USING \(true\)/);
  });

  it("as 6 RPCs de leitura por id: guarda logo depois do BEGIN, com a resposta de sala inexistente", () => {
    for (const [fn, ret] of Object.entries(RPCS)) {
      const body =
        MIG.split(`CREATE OR REPLACE FUNCTION public.${fn}(`)[1] ?? "";
      expect(body, fn).toBeTruthy();
      const afterBegin = body.split("\nBEGIN\n")[1] ?? "";
      expect(afterBegin.split("END IF;")[0]).toContain(
        `IF NOT public.room_read_allowed(p_room_id) THEN\n    RETURN ${ret};`,
      );
      expect(body.split("$function$")[0]).toContain("STABLE SECURITY DEFINER");
    }
  });

  it("canais: políticas em realtime.messages só para broadcast/presença de tópico autorizado", () => {
    expect(MIG).toMatch(
      /ON realtime\.messages\n {2}FOR SELECT TO authenticated\n {2}USING \(\n {4}realtime\.messages\.extension IN \('broadcast', 'presence'\)\n {4}AND \(SELECT public\.realtime_topic_allowed\(realtime\.topic\(\)\)\)/,
    );
    expect(MIG).toMatch(
      /ON realtime\.messages\n {2}FOR INSERT TO authenticated\n {2}WITH CHECK \(/,
    );
    expect(MIG).toContain(
      "'^(?:room|reactions):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'",
    );
    expect(MIG).toContain("IF p_topic = 'latency:' || v_uid::text THEN");
  });

  it("funções novas fora de anon/PUBLIC; room_read_allowed nem para authenticated", () => {
    expect(MIG).toContain(
      "REVOKE ALL ON FUNCTION public.room_read_allowed(uuid) FROM PUBLIC, anon, authenticated;",
    );
    expect(MIG).toContain(
      "REVOKE ALL ON FUNCTION public.realtime_topic_allowed(text) FROM PUBLIC, anon;",
    );
    expect(MIG).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.room_read_allowed\(uuid\) TO [^;]*authenticated/,
    );
  });

  it("rollback devolve as 7 políticas públicas, os 6 corpos sem guarda e apaga o novo", () => {
    for (const t of TABLES) {
      expect(RB).toContain(
        `CREATE POLICY "${OLD[t]}" ON public.${t} FOR SELECT USING (true);`,
      );
      expect(RB).toContain(
        `DROP POLICY IF EXISTS "${t} participantes leem" ON public.${t};`,
      );
    }
    for (const fn of Object.keys(RPCS))
      expect(RB).toContain(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    expect(RB).not.toContain("room_read_allowed(p_room_id)");
    expect(RB).toContain(
      "DROP FUNCTION IF EXISTS public.room_read_allowed(uuid);",
    );
    expect(RB).toContain(
      "DROP FUNCTION IF EXISTS public.realtime_topic_allowed(text);",
    );
    expect(RB).toContain(
      'DROP POLICY IF EXISTS "verbete canais: participante recebe" ON realtime.messages;',
    );
    expect(RB).toContain(
      'DROP POLICY IF EXISTS "verbete canais: participante envia" ON realtime.messages;',
    );
    expect(RB).not.toMatch(/\r/);
  });
});
