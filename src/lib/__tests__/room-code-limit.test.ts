import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { friendlyEntryError, rejoinRefusal } from "@/lib/entry-errors";

// ECA R6 (12/11/2026): limite de tentativas de código de sala
// (20261112090000_limite_tentativas_codigo_sala.sql). O banco é conferido de
// verdade em scripts/test-limite-codigo-sala.mjs (CI, Supabase local); aqui,
// o lado do app e as promessas escritas na migration.
const MIGRATION = readFileSync(
  "supabase/migrations/20261112090000_limite_tentativas_codigo_sala.sql",
  "utf8",
);
const ROLLBACK = readFileSync(
  "supabase/rollback/limite_tentativas_codigo_sala.sql",
  "utf8",
);

describe("rejoinRefusal (retorno {ok:false} do rejoin_room)", () => {
  it("devolve o motivo quando o servidor recusou", () => {
    expect(rejoinRefusal({ ok: false, reason: "room_not_found" })).toBe(
      "room_not_found",
    );
    expect(
      rejoinRefusal({
        ok: false,
        reason: "rate_limited",
        retry_after_secs: 60,
      }),
    ).toBe("rate_limited");
    expect(rejoinRefusal({ ok: false, reason: "room_locked" })).toBe(
      "room_locked",
    );
    expect(rejoinRefusal({ ok: false })).toBe("join_refused");
  });
  it("entrada válida (linha da sala) não é recusa", () => {
    expect(
      rejoinRefusal({ id: "x", code: "1234", status: "lobby" }),
    ).toBeNull();
    expect(rejoinRefusal(null)).toBeNull();
    expect(rejoinRefusal(undefined)).toBeNull();
    expect(rejoinRefusal("texto")).toBeNull();
  });
});

describe("mensagens para o jogador", () => {
  it("rate_limited tem texto próprio (nunca o erro cru)", () => {
    const msg = friendlyEntryError(new Error("rate_limited"), "join");
    expect(msg).toMatch(/Espere alguns minutos/);
    expect(msg).not.toMatch(/rate_limited/);
  });
  it("room_not_found devolvido pelo retorno vira o texto de sempre", () => {
    expect(friendlyEntryError(new Error("room_not_found"), "join")).toBe(
      "Sala não encontrada. Confira o código.",
    );
  });
  it("joinRoom lê o retorno do rejoin_room depois do erro", () => {
    const room = readFileSync("src/lib/room.ts", "utf8");
    expect(room).toMatch(
      /if \(rpcErr\) throw rpcErr;[\s\S]{0,400}rejoinRefusal\(rpcData\)[\s\S]{0,80}throw new Error\(refused\)/,
    );
  });
});

describe("migration (o servidor é quem garante)", () => {
  it("10 falhas em 15 min; registro guardado por 1 hora", () => {
    expect(MIGRATION).toMatch(/AS \$\$ SELECT 10, 900, 3600 \$\$/);
  });
  it("registro pseudonimizado: só hash da identidade e hora", () => {
    const table =
      /CREATE TABLE IF NOT EXISTS public\.room_code_failures \(([\s\S]*?)\n\);/.exec(
        MIGRATION,
      );
    expect(table).not.toBeNull();
    const cols = [...table![1]!.matchAll(/^\s+([a-z_]+) /gm)].map((m) => m[1]);
    expect(cols).toEqual(["id", "uid_hash", "created_at"]);
    expect(MIGRATION).toMatch(
      /sha256\(convert_to\(s\.salt \|\| ':' \|\| p_uid::text/,
    );
  });
  it("tabelas e funções internas fechadas para o cliente", () => {
    for (const t of ["room_code_failures", "room_code_failure_salt"]) {
      expect(MIGRATION).toContain(
        `REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`,
      );
      expect(MIGRATION).toContain(
        `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`,
      );
    }
    for (const f of [
      "room_code_limit()",
      "room_code_uid_hash(uuid)",
      "room_code_retry_after(text)",
      "room_code_record_failure(text)",
      "room_code_failures_cleanup()",
    ])
      expect(MIGRATION).toContain(
        `REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated;`,
      );
  });
  it("trava por identidade contra corrida; falha devolvida, não levantada", () => {
    expect(MIGRATION).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\('room_code:'/,
    );
    expect(MIGRATION).toMatch(
      /RETURN jsonb_build_object\('ok', false, 'reason', 'room_not_found'\)/,
    );
    expect(MIGRATION).toMatch(
      /RETURN jsonb_build_object\('ok', false, 'reason', 'room_locked'\)/,
    );
  });
  it("rollback devolve o rejoin_room anterior e apaga as tabelas", () => {
    expect(ROLLBACK).toMatch(/RAISE EXCEPTION 'room_not_found'/);
    expect(ROLLBACK).not.toMatch(/room_code_retry_after\(v_hash\)/);
    expect(ROLLBACK).toMatch(
      /DROP TABLE IF EXISTS public\.room_code_failures;/,
    );
    expect(ROLLBACK).toMatch(
      /DROP TABLE IF EXISTS public\.room_code_failure_salt;/,
    );
  });
});
