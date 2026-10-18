import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@/lib/room";
import {
  __resetRoomConfigWriter,
  queueRoomConfig,
  withPendingConfig,
  type RoomConfigPatch,
} from "@/lib/room-config-writer";

const ROOM = "room-1";
const HOST = "p_host";
const ROUNDS_10: RoomConfigPatch = { win_condition: "rounds", win_target: 10 };
const ROUNDS_5: RoomConfigPatch = { win_condition: "rounds", win_target: 5 };

function lobby(over: Partial<Room> = {}): Room {
  return {
    id: ROOM,
    code: "1234",
    host_id: HOST,
    status: "lobby",
    win_condition: "score",
    win_target: 15,
    current_round: 0,
    current_coordinator: null,
    current_word_id: null,
    round_phase_ends_at: null,
    created_at: "2026-10-18T00:00:00Z",
    ...over,
  };
}

// Servidor de mentira com a mesma semântica do host_update_room_config:
// aplica o patch quando a requisição chega (a última a pegar o lock vence) e
// emite um eco de realtime por campo gravado — cada campo é um UPDATE, então
// win_condition + win_target geram um eco intermediário.
function fakeServer(initial: Room) {
  let row = { ...initial };
  const echoes: Room[] = [];
  const apply = (patch: RoomConfigPatch) => {
    for (const k of [
      "win_condition",
      "win_target",
      "nivel",
      "categories",
      "mode",
      "teams",
    ] as const) {
      if (k in patch) {
        row = { ...row, [k]: patch[k] } as Room;
        echoes.push({ ...row });
      }
    }
  };
  return {
    get row() {
      return row;
    },
    echoes,
    apply,
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Envio controlado: cada chamada espera o próprio portão antes de chegar ao servidor. */
function gatedSender(server: ReturnType<typeof fakeServer>, gates: number) {
  const calls: RoomConfigPatch[] = [];
  const gs = Array.from({ length: gates }, gate);
  const send = async (
    _room: string,
    _actor: string,
    patch: RoomConfigPatch,
  ) => {
    const i = calls.length;
    calls.push(patch);
    await gs[i]?.opened;
    server.apply(patch);
    return true;
  };
  return { calls, gates: gs, send };
}

/** Entrega os ecos pendentes ao host e devolve o alvo que a tela mostraria. */
function deliverEchoes(server: ReturnType<typeof fakeServer>) {
  return server.echoes
    .splice(0)
    .map((e) => withPendingConfig(e, "realtime").win_target);
}

afterEach(() => __resetRoomConfigWriter());

describe("room-config-writer — fila por sala", () => {
  it("Rodadas e 5 rod. em sequência rápida: a 2ª escrita só sai depois da 1ª e a sala termina em 5", async () => {
    const server = fakeServer(lobby());
    const s = gatedSender(server, 2);
    __resetRoomConfigWriter(s.send);

    queueRoomConfig(ROOM, HOST, ROUNDS_10); // toque em "Rodadas"
    const done = queueRoomConfig(ROOM, HOST, ROUNDS_5); // toque em "5 rod."
    await flush();
    // a 1ª ainda não respondeu (ex.: renovando o token): a 2ª NÃO pode sair
    expect(s.calls).toEqual([ROUNDS_10]);

    s.gates[0]!.open();
    await flush();
    expect(s.calls).toEqual([ROUNDS_10, ROUNDS_5]);
    s.gates[1]!.open();
    await done;
    expect(server.row.win_condition).toBe("rounds");
    expect(server.row.win_target).toBe(5);
  });

  it("selecionar só Rodadas termina em 10", async () => {
    const server = fakeServer(lobby());
    const s = gatedSender(server, 0);
    __resetRoomConfigWriter(s.send);
    await queueRoomConfig(ROOM, HOST, ROUNDS_10);
    expect(server.row.win_target).toBe(10);
    expect(s.calls).toEqual([ROUNDS_10]);
  });

  it("vários toques rápidos viram no máximo 2 escritas e a última leva o valor final", async () => {
    const server = fakeServer(lobby());
    const s = gatedSender(server, 2);
    __resetRoomConfigWriter(s.send);

    queueRoomConfig(ROOM, HOST, ROUNDS_10);
    queueRoomConfig(ROOM, HOST, { win_target: 5 });
    queueRoomConfig(ROOM, HOST, { win_target: 15 });
    queueRoomConfig(ROOM, HOST, { win_target: 20 });
    const done = queueRoomConfig(ROOM, HOST, { win_target: 5 });
    s.gates[0]!.open();
    s.gates[1]!.open();
    await done;
    expect(s.calls).toEqual([ROUNDS_10, { win_target: 5 }]);
    expect(server.row).toMatchObject({
      win_condition: "rounds",
      win_target: 5,
    });
  });

  it("salas diferentes não esperam umas pelas outras", async () => {
    const calls: string[] = [];
    const g = gate();
    __resetRoomConfigWriter(async (room) => {
      calls.push(room);
      if (room === "a") await g.opened;
      return true;
    });
    queueRoomConfig("a", HOST, ROUNDS_10);
    await queueRoomConfig("b", HOST, ROUNDS_5);
    expect(calls).toEqual(["a", "b"]);
    g.open();
  });
});

describe("room-config-writer — eco atrasado não desfaz o último toque", () => {
  it("ecos da 1ª escrita chegam com a 2ª pendente, e os da 2ª depois da resposta: a tela fica em 5 o tempo todo", async () => {
    const server = fakeServer(lobby());
    const s = gatedSender(server, 2);
    __resetRoomConfigWriter(s.send);

    queueRoomConfig(ROOM, HOST, ROUNDS_10);
    const done = queueRoomConfig(ROOM, HOST, ROUNDS_5);
    s.gates[0]!.open(); // 1ª aplicada: ecos (rounds,15) e (rounds,10)
    await flush();
    const seen = deliverEchoes(server);
    s.gates[1]!.open(); // 2ª aplicada: ecos (rounds,10) e (rounds,5)
    await done;
    seen.push(...deliverEchoes(server));
    expect(seen).toEqual([5, 5, 5, 5]);

    // confirmado: uma mudança posterior do servidor passa direto
    expect(
      withPendingConfig(
        lobby({ win_condition: "rounds", win_target: 20 }),
        "realtime",
      ).win_target,
    ).toBe(20);
  });

  it("todos os ecos atrasados para depois da fila esvaziar — inclusive voltando ao valor inicial — nunca mostram o 10", async () => {
    // sala já estava em 5; o host toca 10 e volta para 5 antes de qualquer eco
    const server = fakeServer(
      lobby({ win_condition: "rounds", win_target: 5 }),
    );
    const s = gatedSender(server, 2);
    __resetRoomConfigWriter(s.send);

    queueRoomConfig(ROOM, HOST, ROUNDS_10);
    const done = queueRoomConfig(ROOM, HOST, ROUNDS_5);
    s.gates[0]!.open();
    s.gates[1]!.open();
    await done;
    const seen = deliverEchoes(server);
    expect(seen).toEqual([5, 5, 5, 5]);
    expect(seen).not.toContain(10);
  });

  it("eco final antes da resposta HTTP: ao terminar a fila a proteção sai sem esperar outro eco", async () => {
    const server = fakeServer(lobby());
    const s = gatedSender(server, 1);
    __resetRoomConfigWriter(async (r, a, patch) => {
      const ok = await s.send(r, a, patch);
      deliverEchoes(server); // o realtime entregou antes da resposta
      return ok;
    });
    const done = queueRoomConfig(ROOM, HOST, ROUNDS_5);
    s.gates[0]!.open();
    await done;
    expect(
      withPendingConfig(
        lobby({ win_condition: "rounds", win_target: 20 }),
        "realtime",
      ).win_target,
    ).toBe(20);
  });

  it("recarga completa (snapshot) no meio da fila não desfaz o toque nem conta como eco", async () => {
    const server = fakeServer(lobby());
    const s = gatedSender(server, 2);
    __resetRoomConfigWriter(s.send);
    queueRoomConfig(ROOM, HOST, ROUNDS_10);
    const done = queueRoomConfig(ROOM, HOST, ROUNDS_5);
    s.gates[0]!.open();
    await flush();
    // snapshot tirado entre as duas escritas (mostra 10)
    expect(withPendingConfig({ ...server.row }, "snapshot").win_target).toBe(5);
    s.gates[1]!.open();
    await done;
    expect(deliverEchoes(server)).toEqual([5, 5, 5, 5]);
  });
});

describe("room-config-writer — autoridade e falhas", () => {
  it("escrita recusada: descarta a intenção e pede recarga da sala", async () => {
    const onResync = vi.fn();
    window.addEventListener("room:config-resync", onResync);
    __resetRoomConfigWriter(async () => false);
    await queueRoomConfig(ROOM, HOST, ROUNDS_5);
    window.removeEventListener("room:config-resync", onResync);
    expect(onResync).toHaveBeenCalledTimes(1);
    // nada fica por cima da verdade do servidor
    expect(withPendingConfig(lobby()).win_target).toBe(15);
  });

  it("erro de rede também recarrega, e a próxima escrita volta a funcionar", async () => {
    let fail = true;
    const sent: RoomConfigPatch[] = [];
    __resetRoomConfigWriter(async (_r, _a, patch) => {
      sent.push(patch);
      if (fail) throw new Error("offline");
      return true;
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await queueRoomConfig(ROOM, HOST, ROUNDS_10);
    fail = false;
    await queueRoomConfig(ROOM, HOST, ROUNDS_5);
    expect(sent).toEqual([ROUNDS_10, ROUNDS_5]);
    spy.mockRestore();
  });

  it("jogo começou ou o host mudou: a proteção some e vale a linha do servidor", () => {
    const g = gate();
    __resetRoomConfigWriter(async () => {
      await g.opened;
      return true;
    });
    queueRoomConfig(ROOM, HOST, ROUNDS_5);
    expect(
      withPendingConfig(lobby({ status: "choosing", win_target: 10 }))
        .win_target,
    ).toBe(10);
    queueRoomConfig(ROOM, HOST, ROUNDS_5);
    expect(
      withPendingConfig(lobby({ host_id: "p_outro", win_target: 10 }))
        .win_target,
    ).toBe(10);
    g.open();
  });

  it("convidado (sem escrita própria) recebe a linha do servidor sem alteração", () => {
    const row = lobby({ win_condition: "rounds", win_target: 10 });
    expect(withPendingConfig(row, "realtime")).toBe(row);
  });
});
