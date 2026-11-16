import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Fase 3 (20261113090000): as 8 RPCs que mudam a partida conferem quem chama.
// Aqui: (1) a ÚLTIMA definição de cada uma nas migrations tem a guarda; (2) o
// rollback devolve os corpos sem ela e apaga as funções novas; (3) o cliente
// trata a recusa nova (not_authorized) sem quebrar. O comportamento no banco
// (sem sessão, de fora, expulso, coordenador, host, concorrência) é provado na
// integração da CI (scripts/test-autorizacao-fase3.mjs) e no isolado.
const h = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(async () => h.result) },
}));

import {
  applyVotingTimeoutOrAdvance,
  applyWritingTimeoutOrAdvance,
  chooseWord,
  startShuffling,
} from "@/lib/room";

const ROOT = process.cwd();
const DIR = join(ROOT, "supabase/migrations");
const SQL = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(DIR, f), "utf8"))
  .join("\n");
const MIG = readFileSync(
  join(DIR, "20261113090000_autorizacao_fase3.sql"),
  "utf8",
);
const RB = readFileSync(
  join(ROOT, "supabase/rollback/autorizacao_fase3.sql"),
  "utf8",
);

function lastDef(sql: string, name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`, "g");
  let at = -1;
  for (let m = re.exec(sql); m; m = re.exec(sql)) at = m.index;
  if (at < 0) throw new Error(`função ${name} não encontrada`);
  const rest = sql.slice(at + 1);
  const end = rest.search(
    /\nCREATE OR REPLACE FUNCTION|\nREVOKE|\nGRANT|\nDROP /,
  );
  return sql.slice(at, at + 1 + (end < 0 ? rest.length : end));
}

const RPCS = [
  "choose_word",
  "start_shuffling",
  "advance_writing_to_voting",
  "extend_writing_or_advance",
  "advance_voting_to_reveal",
  "extend_voting_or_advance",
  "finish_reveal",
  "advance_scoreboard_to_next_round_or_finished",
];

describe("migration: as 8 RPCs de partida conferem quem chama", () => {
  it.each(RPCS)("%s: a definição vigente passa pela guarda", (fn) => {
    expect(lastDef(SQL, fn)).toContain("public.room_actor_gate(p_room_id)");
  });
  it("choose_word: só o coordenador (ou participante se o coordenador é bot)", () => {
    const d = lastDef(SQL, "choose_word");
    expect(d).toContain(
      "public.room_actor_is(p_room_id, v_room.current_coordinator)",
    );
    expect(d).toMatch(/b\.is_bot AND b\.kicked_at IS NULL/);
    expect(d).toContain(
      "LEAST(GREATEST(COALESCE(p_duration_sec, 60), 30), 120)",
    );
  });
  it("finish_reveal e placar com p_force: só o host", () => {
    expect(lastDef(SQL, "finish_reveal")).toContain(
      "public.room_actor_is(p_room_id, v_room.host_id)",
    );
    expect(
      lastDef(SQL, "advance_scoreboard_to_next_round_or_finished"),
    ).toMatch(
      /IF p_force AND NOT public\.room_actor_is\(p_room_id, v_room\.host_id\)/,
    );
  });
  it("participante = linha ATIVA da sessão (expulso e bot não contam); interno passa", () => {
    const gate = lastDef(MIG, "room_actor_gate");
    expect(gate).toContain("p.user_id = auth.uid()");
    expect(gate).toContain("p.kicked_at IS NULL");
    expect(gate).toContain("NOT p.is_bot");
    expect(gate).toContain("NOT IN ('anon', 'authenticated') THEN 'internal'");
  });
  it("funções novas fora da API", () => {
    expect(MIG).toMatch(
      /REVOKE ALL ON FUNCTION public\.room_actor_gate\(uuid\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(MIG).toMatch(
      /REVOKE ALL ON FUNCTION public\.room_actor_is\(uuid, text\) FROM PUBLIC, anon, authenticated;/,
    );
  });
  it("rollback: as 8 voltam sem guarda e as 2 funções novas somem", () => {
    for (const fn of RPCS) expect(lastDef(RB, fn)).not.toContain("room_actor_");
    expect(RB).toContain(
      "DROP FUNCTION IF EXISTS public.room_actor_is(uuid, text);",
    );
    expect(RB).toContain(
      "DROP FUNCTION IF EXISTS public.room_actor_gate(uuid);",
    );
    expect(RB).not.toMatch(/^(BEGIN|COMMIT);/m);
  });
});

describe("cliente: a recusa nova não quebra o fluxo", () => {
  it("chooseWord recusado (not_authorized) não lança", async () => {
    h.result = { data: { ok: false, reason: "not_authorized" }, error: null };
    await expect(chooseWord("r1", "w1")).resolves.toBeUndefined();
  });
  it("startShuffling de quem não pode → false (o timer/cron segue)", async () => {
    h.result = { data: { ok: false, reason: "invalid_state" }, error: null };
    await expect(startShuffling("r1")).resolves.toBe(false);
  });
  it("prorrogações recusadas viram noop (o cliente não avança sozinho)", async () => {
    h.result = { data: { action: "noop" }, error: null };
    await expect(applyWritingTimeoutOrAdvance("r1")).resolves.toMatchObject({
      action: "noop",
      extended: false,
    });
    await expect(applyVotingTimeoutOrAdvance("r1")).resolves.toMatchObject({
      action: "noop",
      advanced: false,
    });
  });
});
