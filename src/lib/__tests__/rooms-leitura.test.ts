import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anon, fakeAuth, rpc } from "@/test/fake-auth";

// Salas: leitura restrita a participantes (migration 20261112110000).
// O servidor garante (suíte scripts/test-rooms-leitura.mjs na CI, com
// PostgREST e Realtime reais); aqui: o app novo não depende mais de ler
// `rooms` por código antes de entrar, e o texto da migration/rollback.
vi.mock(
  "@/integrations/supabase/client",
  async () => (await import("@/test/fake-auth")).supabaseModule,
);

const ROOT = resolve(__dirname, "../../..");
const A = "00000000-0000-4000-8000-0000000000a1";
const ROOM = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "4321",
  host_id: "h1",
  status: "lobby",
};
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MIG = read(
  "supabase/migrations/20261112110000_rooms_leitura_restrita.sql",
);
const RB = read("supabase/rollback/rooms_leitura_restrita.sql");

type Res = { data: unknown; error: { message: string } | null };
function rpcs(byName: Record<string, Res | Res[]>) {
  const queues = Object.fromEntries(
    Object.entries(byName).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
  );
  rpc.mockImplementation((fn: string) => {
    const q = queues[fn];
    const r = Array.isArray(q) ? (q.length > 1 ? q.shift() : q[0]) : q;
    return Promise.resolve(r ?? { data: null, error: null });
  });
}
async function freshRoom() {
  fakeAuth.reset(anon(A));
  vi.resetModules();
  const t = await import("../terms-consent");
  t.acceptTerms();
  return import("../room");
}

beforeEach(() => {
  localStorage.clear();
  rpc.mockReset();
});
afterEach(() => {
  // devolve o padrão do fake-auth (toda RPC = erro de teste)
  rpc.mockImplementation(() =>
    Promise.resolve({ data: null, error: { message: "rpc de teste" } }),
  );
  vi.restoreAllMocks();
});

describe("joinRoom sem ler rooms por código", () => {
  it("entra só pelas RPCs e devolve a sala que a rejoin_room devolve", async () => {
    rpcs({
      is_player_banned: { data: false, error: null },
      rejoin_room: { data: ROOM, error: null },
    });
    const room = await freshRoom();
    // fake-auth: supabase.from() lança — qualquer leitura de tabela quebraria aqui
    await expect(
      room.joinRoom("4321", "p1", "Bia", "🦊", "#FF5C8A"),
    ).resolves.toEqual(ROOM);
    const names = rpc.mock.calls.map((c) => c[0]);
    expect(names).toContain("rejoin_room");
    expect(names.indexOf("is_player_banned")).toBeLessThan(
      names.indexOf("rejoin_room"),
    );
  });

  it("código inexistente: o erro da rejoin_room vira 'Sala não encontrada'", async () => {
    rpcs({
      is_player_banned: { data: false, error: null },
      rejoin_room: { data: null, error: { message: "room_not_found" } },
    });
    const room = await freshRoom();
    const { friendlyEntryError } = await import("../entry-errors");
    const err = await room
      .joinRoom("9999", "p1", "Bia", "🦊", "#FF5C8A")
      .catch((e: unknown) => e);
    expect(friendlyEntryError(err, "join")).toBe(
      "Sala não encontrada. Confira o código.",
    );
  });

  it("player_id_taken: tenta 1x com id novo e devolve a sala da 2ª chamada", async () => {
    rpcs({
      is_player_banned: { data: false, error: null },
      rejoin_room: [
        { data: null, error: { message: "player_id_taken" } },
        { data: ROOM, error: null },
      ],
    });
    const room = await freshRoom();
    await expect(
      room.joinRoom("4321", "p1", "Bia", "🦊", "#FF5C8A"),
    ).resolves.toEqual(ROOM);
    expect(rpc.mock.calls.filter((c) => c[0] === "rejoin_room")).toHaveLength(
      2,
    );
  });

  it("banido não chega à rejoin_room", async () => {
    rpcs({ is_player_banned: { data: true, error: null } });
    const room = await freshRoom();
    await expect(
      room.joinRoom("4321", "p1", "Bia", "🦊", "#FF5C8A"),
    ).rejects.toThrow(/banido/);
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain("rejoin_room");
  });

  it("joinedRoom: sem a linha da sala, devolve o mínimo para navegar", async () => {
    const { joinedRoom } = await import("../room");
    expect(joinedRoom(ROOM, "4321")).toBe(ROOM);
    expect(joinedRoom(null, "4321")).toEqual({ code: "4321" });
    expect(joinedRoom({ ok: false, reason: "x" }, "4321")).toEqual({
      code: "4321",
    });
  });

  it("nenhum código do app lê rooms por código fora do fallback legado", () => {
    expect(read("src/lib/room.ts")).not.toMatch(
      /from\("rooms"\)[^;]*eq\("code"/,
    );
    const data = read("src/hooks/room/use-room-data.ts");
    // a sessão vem antes do get_room_state (convite aberto a frio)
    expect(data.indexOf("await ensureAnonSession()")).toBeGreaterThan(-1);
    expect(data.indexOf("await ensureAnonSession()")).toBeLessThan(
      data.indexOf('rpc("get_room_state"'),
    );
    // sem sala carregada, o polling não insiste sozinho (limite do #73)
    expect(read("src/hooks/room/use-room-polling.ts")).toMatch(
      /if \(!roomRef\.current\) return;/,
    );
  });
});

describe("migration 20261112110000 (texto)", () => {
  it("tira a leitura pública e deixa só participantes + transitória do vc8, ambas só authenticated", () => {
    expect(MIG).toMatch(
      /DROP POLICY IF EXISTS "public read rooms" ON public\.rooms;/,
    );
    expect(MIG).not.toMatch(/CREATE POLICY "public read rooms"/);
    const pols = [
      ...MIG.matchAll(
        /CREATE POLICY "([^"]+)" ON public\.rooms\s+FOR SELECT TO (\w+)/g,
      ),
    ];
    expect(pols.map((m) => [m[1], m[2]])).toEqual([
      ["rooms participantes leem", "authenticated"],
      ["rooms vc8 leitura por codigo exato (transitoria)", "authenticated"],
    ]);
    // avaliadas uma vez por instrução (sem custo por linha numa listagem)
    expect(MIG).toMatch(/USING \(id IN \(SELECT public\.my_room_ids\(\)\)\)/);
    expect(MIG).toMatch(
      /USING \(\(SELECT public\.rooms_vc8_exact_code_read\(\)\)\)/,
    );
  });

  it("interruptor: nasce 'ligado', ausente = desligado; funções novas fora de anon", () => {
    expect(MIG).toMatch(
      /VALUES \('rooms_vc8_compat', 'ligado'\)\s+ON CONFLICT \(key\) DO NOTHING/,
    );
    expect(MIG).toMatch(
      /COALESCE\(\(SELECT value FROM public\.app_config WHERE key = 'rooms_vc8_compat'\), ''\) = 'ligado'/,
    );
    for (const f of [
      "rooms_vc8_compat_on()",
      "is_room_participant(uuid)",
      "my_room_ids()",
      "rooms_vc8_exact_code_read()",
    ])
      expect(MIG).toContain(
        `REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon`,
      );
    expect(MIG).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*TO[^;]*\banon\b/);
  });

  it("get_room_state: participante igual a antes; de fora só a sala; limite do #73 só se existir", () => {
    expect(MIG).toMatch(/VOLATILE SECURITY DEFINER/);
    expect(MIG).toContain(
      "to_regprocedure('public.room_code_record_failure(text)') IS NOT NULL",
    );
    expect(MIG).toMatch(
      /'players', '\[\]'::jsonb,\s+'definitions', '\[\]'::jsonb,\s+'votes', '\[\]'::jsonb,\s+'word', NULL/,
    );
  });

  it("rollback devolve a política pública e apaga o que a migration criou", () => {
    expect(RB).toMatch(
      /CREATE POLICY "public read rooms" ON public\.rooms FOR SELECT USING \(true\);/,
    );
    expect(RB).toMatch(/STABLE SECURITY DEFINER/);
    for (const f of [
      "rooms_vc8_exact_code_read()",
      "is_room_participant(uuid)",
      "my_room_ids()",
      "rooms_vc8_compat_on()",
    ])
      expect(RB).toContain(`DROP FUNCTION IF EXISTS public.${f};`);
    expect(RB).toContain(
      "DELETE FROM public.app_config WHERE key = 'rooms_vc8_compat';",
    );
    expect(RB).not.toMatch(/\r/);
    expect(MIG).not.toMatch(/\r/);
  });
});
