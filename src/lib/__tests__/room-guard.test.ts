// V3 mínima (05/11/2026): guarda das edges de IA — decisão inteira, sem
// banco nem rede (o acesso real fica em supabase/functions/_shared/
// room-guard-deps.ts e é coberto pelo scripts/test-edges-e2e.mjs na CI).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bearerToken,
  blockedBody,
  DEFAULT_ROUND_LIMIT,
  GUARD_MODE_KEY,
  guardEvent,
  MAX_ROUND_LIMIT,
  MIN_ROUND_LIMIT,
  parseGuardMode,
  parseRoundLimit,
  quotaKey,
  ROUND_LIMIT_KEY,
  runRoomGuard,
  type GuardDeps,
  type GuardMode,
  type Identity,
} from "../../../supabase/functions/_shared/room-guard.ts";
import {
  decideJudge,
  decideLease,
  JUDGE_STALE_MS,
  judgeGuardEvent,
  judgeSkipReason,
} from "../../../supabase/functions/_shared/judge-guard.ts";

const ROOM = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOM = "22222222-2222-4222-8222-222222222222";
const GUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // convidado anônimo
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // jogador de OUTRA sala
const TOKENS: Record<string, Identity> = {
  "jwt-convidado": { kind: "user", userId: GUEST },
  "jwt-estranho": { kind: "user", userId: STRANGER },
  "chave-anon": { kind: "none" },
  "jwt-auth-fora": { kind: "error" },
};
const MEMBERS: Record<string, string[]> = {
  [ROOM]: [GUEST],
  [OTHER_ROOM]: [STRANGER],
};

function fakeDeps(
  config: Record<string, string | null>,
  opts: {
    used?: number;
    memberError?: boolean;
    configError?: boolean;
    quotaError?: { code: string };
    quotaReturn?: number;
  } = {},
) {
  const counters = new Map<string, number>();
  const deps: GuardDeps = {
    readConfig: vi.fn(async (key: string) => {
      if (opts.configError) throw new Error("app_config fora");
      return config[key] ?? null;
    }),
    identify: vi.fn(
      async (token: string): Promise<Identity> =>
        TOKENS[token] ?? { kind: "none" },
    ),
    isMember: vi.fn(async (roomId: string, userId: string) => {
      if (opts.memberError) throw new Error("players fora");
      return (MEMBERS[roomId] ?? []).includes(userId);
    }),
    takeQuota: vi.fn(async (roomId: string, round: number) => {
      // como o PostgREST: erro de permissão vira objeto com code (ex.: 42501)
      if (opts.quotaError)
        throw Object.assign(new Error("permission denied"), opts.quotaError);
      if (opts.quotaReturn !== undefined) return opts.quotaReturn;
      const key = quotaKey(roomId, round);
      const n = (counters.get(key) ?? opts.used ?? 0) + 1;
      counters.set(key, n);
      return n;
    }),
  };
  return { deps, counters };
}

const ask = (token: string, askedRoomId = ROOM, round = 1) => ({
  token,
  askedRoomId,
  roomId: askedRoomId || ROOM,
  round,
});

describe("modo e configuração", () => {
  it("modo: só os três valores; ausente ou inválido = observar (nunca aplicar)", () => {
    expect(parseGuardMode("desligado")).toBe("desligado");
    expect(parseGuardMode("observar")).toBe("observar");
    expect(parseGuardMode("aplicar")).toBe("aplicar");
    for (const v of [
      null,
      undefined,
      "",
      "APLICAR",
      " aplicar",
      "on",
      "1",
      1,
      true,
    ])
      expect(parseGuardMode(v)).toBe("observar");
  });

  it("limite por rodada: inteiro dentro de [mín, máx]; lixo = padrão", () => {
    expect(parseRoundLimit("60")).toBe(60);
    expect(parseRoundLimit(" 80 ")).toBe(80);
    expect(parseRoundLimit("0")).toBe(MIN_ROUND_LIMIT);
    expect(parseRoundLimit("5")).toBe(MIN_ROUND_LIMIT);
    expect(parseRoundLimit("999999")).toBe(MAX_ROUND_LIMIT);
    for (const v of [null, undefined, "", "-1", "1e3", "abc", "12.5"])
      expect(parseRoundLimit(v)).toBe(DEFAULT_ROUND_LIMIT);
  });

  it("token: só 'Bearer <x>'", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    for (const v of [
      null,
      undefined,
      "",
      "abc",
      "Basic abc",
      "Bearer ",
      "Bearer a b",
    ])
      expect(bearerToken(v)).toBe("");
  });

  it("cota por sala E rodada", () => {
    expect(quotaKey(ROOM, 3)).toBe(`bots_round:${ROOM}:3`);
    expect(quotaKey(ROOM, 3)).not.toBe(quotaKey(ROOM, 4));
  });
});

describe("runRoomGuard — modo aplicar", () => {
  const cfg = { [GUARD_MODE_KEY]: "aplicar" };

  it("sem token → 401, sem consultar auth nem gastar cota", async () => {
    const { deps } = fakeDeps(cfg);
    const g = await runRoomGuard(deps, ask(""));
    expect(g).toEqual({
      mode: "aplicar",
      decision: "no_session",
      block: true,
      status: 401,
    });
    expect(deps.identify).not.toHaveBeenCalled();
    expect(deps.takeQuota).not.toHaveBeenCalled();
  });

  it("chave anon / token inválido (sem usuário) → 401", async () => {
    const { deps } = fakeDeps(cfg);
    const g = await runRoomGuard(deps, ask("chave-anon"));
    expect(g.decision).toBe("no_session");
    expect(g.status).toBe(401);
    expect(g.block).toBe(true);
  });

  it("jogador de OUTRA sala → 403, sem gastar cota", async () => {
    const { deps } = fakeDeps(cfg);
    const g = await runRoomGuard(deps, ask("jwt-estranho"));
    expect(g).toEqual({
      mode: "aplicar",
      decision: "not_member",
      block: true,
      status: 403,
    });
    expect(deps.isMember).toHaveBeenCalledWith(ROOM, STRANGER);
    expect(deps.takeQuota).not.toHaveBeenCalled();
  });

  it("convidado anônimo da PRÓPRIA sala → segue para a IA", async () => {
    const { deps } = fakeDeps(cfg);
    const g = await runRoomGuard(deps, ask("jwt-convidado"));
    expect(g).toEqual({
      mode: "aplicar",
      decision: "ok",
      block: false,
      status: 200,
    });
    expect(deps.takeQuota).toHaveBeenCalledWith(ROOM, 1);
  });

  it("CI #42: cota sem permissão (42501) → guard_error com etapa e código, sem lançar", async () => {
    const { deps } = fakeDeps(cfg, { quotaError: { code: "42501" } });
    const g = await runRoomGuard(deps, ask("jwt-convidado"));
    expect(g).toEqual({
      mode: "aplicar",
      decision: "guard_error",
      block: true,
      status: 503,
      stage: "quota",
      errorCode: "42501",
    });
    expect(guardEvent("bot-definitions-v2", g).payload).toEqual({
      fn: "bot-definitions-v2",
      mode: "aplicar",
      decision: "guard_error",
      blocked: true,
      stage: "quota",
      error_code: "42501",
    });
  });

  it("contador inválido do banco (null/0/NaN) nunca vira 'ok'", async () => {
    for (const bad of [0, NaN, -1, 1.5]) {
      const { deps } = fakeDeps(cfg, { quotaReturn: bad });
      const g = await runRoomGuard(deps, ask("jwt-convidado"));
      expect(g.decision).toBe("guard_error");
      expect(g.stage).toBe("quota");
    }
  });

  it("cota excedida → 429 (o pedido N+1 da rodada)", async () => {
    const { deps } = fakeDeps({ ...cfg, [ROUND_LIMIT_KEY]: "20" });
    const decisions: string[] = [];
    for (let i = 0; i < 22; i++)
      decisions.push((await runRoomGuard(deps, ask("jwt-convidado"))).decision);
    expect(decisions.slice(0, 20).every((d) => d === "ok")).toBe(true);
    const last = await runRoomGuard(deps, ask("jwt-convidado"));
    expect(last).toEqual({
      mode: "aplicar",
      decision: "quota_exceeded",
      block: true,
      status: 429,
    });
    expect(decisions.slice(20)).toEqual(["quota_exceeded", "quota_exceeded"]);
  });

  it("rodada nova da mesma sala tem cota nova", async () => {
    const { deps } = fakeDeps(
      { ...cfg, [ROUND_LIMIT_KEY]: "20" },
      { used: 20 },
    );
    expect(
      (await runRoomGuard(deps, ask("jwt-convidado", ROOM, 1))).decision,
    ).toBe("quota_exceeded");
    const { deps: deps2 } = fakeDeps({ ...cfg, [ROUND_LIMIT_KEY]: "20" });
    expect(
      (await runRoomGuard(deps2, ask("jwt-convidado", ROOM, 2))).decision,
    ).toBe("ok");
  });

  it("sem limite configurado = padrão", async () => {
    const { deps } = fakeDeps(cfg, { used: DEFAULT_ROUND_LIMIT - 1 });
    expect((await runRoomGuard(deps, ask("jwt-convidado"))).decision).toBe(
      "ok",
    );
    expect((await runRoomGuard(deps, ask("jwt-convidado"))).decision).toBe(
      "quota_exceeded",
    );
  });

  it("sem room_id → 400 (o client sempre manda a sala)", async () => {
    const { deps } = fakeDeps(cfg);
    const g = await runRoomGuard(deps, ask("jwt-convidado", ""));
    expect(g).toEqual({
      mode: "aplicar",
      decision: "room_required",
      block: true,
      status: 400,
    });
  });

  it("auth fora do ar → 503 (não se confunde com abuso)", async () => {
    const { deps } = fakeDeps(cfg);
    const g = await runRoomGuard(deps, ask("jwt-auth-fora"));
    expect(g.decision).toBe("auth_unavailable");
    expect(g.status).toBe(503);
  });

  it("erro do banco na verificação → guard_error (nunca lança)", async () => {
    const { deps } = fakeDeps(cfg, { memberError: true });
    const g = await runRoomGuard(deps, ask("jwt-convidado"));
    expect(g).toMatchObject({
      mode: "aplicar",
      decision: "guard_error",
      block: true,
      status: 503,
      stage: "member",
    });
  });
});

describe("runRoomGuard — observar e desligado nunca bloqueiam", () => {
  const cases: Array<[string, ReturnType<typeof ask>]> = [
    ["sem token", ask("")],
    ["chave anon", ask("chave-anon")],
    ["outra sala", ask("jwt-estranho")],
    ["sem room_id", ask("jwt-convidado", "")],
    ["auth fora", ask("jwt-auth-fora")],
    ["convidado da sala", ask("jwt-convidado")],
  ];
  const modes: Array<[string, Record<string, string | null>, GuardMode]> = [
    ["observar explícito", { [GUARD_MODE_KEY]: "observar" }, "observar"],
    ["modo ausente", {}, "observar"],
    ["modo inválido", { [GUARD_MODE_KEY]: "ligado" }, "observar"],
    ["desligado", { [GUARD_MODE_KEY]: "desligado" }, "desligado"],
  ];
  for (const [label, cfg, mode] of modes)
    for (const [what, input] of cases)
      it(`${label}: ${what} → não bloqueia`, async () => {
        const { deps } = fakeDeps(cfg);
        const g = await runRoomGuard(deps, input);
        expect(g.mode).toBe(mode);
        expect(g.block).toBe(false);
      });

  it("observar registra a decisão que o aplicar tomaria (inclusive cota)", async () => {
    const { deps } = fakeDeps({ [GUARD_MODE_KEY]: "observar" }, { used: 999 });
    expect((await runRoomGuard(deps, ask("jwt-estranho"))).decision).toBe(
      "not_member",
    );
    expect((await runRoomGuard(deps, ask(""))).decision).toBe("no_session");
    const q = await runRoomGuard(deps, ask("jwt-convidado"));
    expect(q).toEqual({
      mode: "observar",
      decision: "quota_exceeded",
      block: false,
      status: 429,
    });
  });

  it("leitura do modo falhou → observar (nunca aplicar por acidente)", async () => {
    const { deps } = fakeDeps({}, { configError: true });
    const g = await runRoomGuard(deps, ask(""));
    expect(g).toMatchObject({
      mode: "observar",
      decision: "no_session",
      block: false,
    });
  });

  it("desligado não toca auth, players nem cota (fluxo antigo)", async () => {
    const { deps } = fakeDeps({ [GUARD_MODE_KEY]: "desligado" });
    await runRoomGuard(deps, ask(""));
    expect(deps.identify).not.toHaveBeenCalled();
    expect(deps.isMember).not.toHaveBeenCalled();
    expect(deps.takeQuota).not.toHaveBeenCalled();
  });
});

describe("telemetria e resposta de bloqueio", () => {
  it("evento ai_guard sem usuário, sala ou token", async () => {
    const { deps } = fakeDeps({ [GUARD_MODE_KEY]: "aplicar" });
    const g = await runRoomGuard(deps, ask("jwt-estranho"));
    const ev = guardEvent("bot-definitions-v2", g);
    expect(ev).toEqual({
      kind: "ai_guard",
      payload: {
        fn: "bot-definitions-v2",
        mode: "aplicar",
        decision: "not_member",
        blocked: true,
      },
    });
    const txt = JSON.stringify(ev);
    for (const s of [ROOM, STRANGER, "jwt-estranho"])
      expect(txt).not.toContain(s);
  });

  it("corpo do bloqueio = listas vazias (o client já cai nas reservas locais)", () => {
    expect(blockedBody("quota_exceeded")).toEqual({
      error: "quota_exceeded",
      definitions: [],
      fallbacks: [],
    });
  });
});

describe("score-similarity: rodada já julgada não volta à IA", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  const fresh = {
    judged_at: null,
    judge_attempts: 1,
    scored_at: "2026-11-05T11:59:30Z",
  };

  it("motivos: julgada, desistida, fora da janela; rodada em julgamento = null", () => {
    expect(judgeSkipReason(fresh, now)).toBeNull();
    expect(
      judgeSkipReason({ ...fresh, judged_at: "2026-11-05T11:59:50Z" }, now),
    ).toBe("already_judged");
    expect(judgeSkipReason({ ...fresh, judge_attempts: 4 }, now)).toBe(
      "gave_up",
    );
    expect(judgeSkipReason({ ...fresh, judge_attempts: 3 }, now)).toBeNull();
    const old = new Date(now - JUDGE_STALE_MS - 1000).toISOString();
    expect(judgeSkipReason({ ...fresh, scored_at: old }, now)).toBe("stale");
    // a janela do reenvio do banco (15 min) fica inteira dentro da folga
    const retryWindow = new Date(now - 15 * 60 * 1000 - 30_000).toISOString();
    expect(
      judgeSkipReason({ ...fresh, scored_at: retryWindow }, now),
    ).toBeNull();
    expect(judgeSkipReason({}, now)).toBeNull();
  });

  it("aplicar pula; observar só registra; desligado ignora", () => {
    const judged = { ...fresh, judged_at: "2026-11-05T11:59:50Z" };
    expect(decideJudge("aplicar", judged, now)).toEqual({
      mode: "aplicar",
      reason: "already_judged",
      skip: true,
    });
    expect(decideJudge("observar", judged, now)).toEqual({
      mode: "observar",
      reason: "already_judged",
      skip: false,
    });
    expect(decideJudge("desligado", judged, now)).toEqual({
      mode: "desligado",
      reason: null,
      skip: false,
    });
    expect(decideJudge("aplicar", fresh, now)).toEqual({
      mode: "aplicar",
      reason: null,
      skip: false,
    });
  });

  it("evento do juiz sem sala nem rodada", () => {
    const ev = judgeGuardEvent({
      mode: "aplicar",
      reason: "already_judged",
      skip: true,
    });
    expect(ev).toEqual({
      kind: "ai_guard",
      payload: {
        fn: "score-similarity",
        mode: "aplicar",
        decision: "already_judged",
        blocked: true,
      },
    });
  });
});

describe("score-similarity: uma avaliação por rodada de cada vez", () => {
  it("ocupada: aplicar pula (com error, o reenvio tenta de novo); observar só registra", () => {
    expect(decideLease("aplicar", false)).toEqual({
      mode: "aplicar",
      reason: "in_progress",
      skip: true,
    });
    expect(decideLease("observar", false)).toEqual({
      mode: "observar",
      reason: "in_progress",
      skip: false,
    });
  });

  it("reservou, falhou ao reservar (null) ou desligado → segue (nunca impede o juiz legítimo)", () => {
    for (const mode of ["aplicar", "observar", "desligado"] as const)
      for (const took of [true, null]) {
        expect(decideLease(mode, took)).toEqual({
          mode,
          reason: null,
          skip: false,
        });
      }
    expect(decideLease("desligado", false).skip).toBe(false);
  });
});

describe("as edges usam a guarda ANTES da IA", () => {
  const src = (f: string) =>
    readFileSync(join(__dirname, "../../../supabase/functions", f), "utf8");

  for (const f of ["bot-definitions/index.ts", "bot-definitions-v2/index.ts"])
    it(`${f}: runRoomGuard antes do Gemini, bloqueio só com guard.block`, () => {
      const s = src(f);
      const guard = s.indexOf("runRoomGuard(supabaseGuardDeps(admin)");
      expect(guard).toBeGreaterThan(0);
      expect(guard).toBeLessThan(s.indexOf("resolveAiProvider("));
      expect(s).toMatch(/if \(guard\.block\)/);
      expect(s).toContain('bearerToken(req.headers.get("authorization"))');
    });

  it("score-similarity: decideJudge antes do Gemini e resposta sem 'error'", () => {
    const s = src("score-similarity/index.ts");
    const guard = s.indexOf("decideJudge(");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(s.indexOf("resolveAiProvider("));
    expect(s).toContain("json({ matches: [], skipped: judgeGuard.reason })");
  });

  it("score-similarity: reserva da rodada depois do judged_at, antes do Gemini; solta no finally", () => {
    const s = src("score-similarity/index.ts");
    const judged = s.indexOf("decideJudge(");
    const take = s.indexOf('admin.rpc("judge_lease_take"');
    const recheck = s.indexOf('.select("judged_at")');
    const gemini = s.indexOf("resolveAiProvider(");
    expect(judged).toBeGreaterThan(0);
    expect(take).toBeGreaterThan(judged);
    expect(recheck).toBeGreaterThan(take);
    expect(gemini).toBeGreaterThan(recheck);
    // ocupada em 'aplicar' responde COM error: o reenvio do banco tenta de novo
    expect(s).toContain('json({ matches: [], error: "judge_in_progress" })');
    const fin = s.lastIndexOf("} finally {");
    expect(fin).toBeGreaterThan(gemini);
    expect(s.indexOf('admin.rpc("judge_lease_release"')).toBeGreaterThan(fin);
  });

  it("migration: config padrão observar sem sobrescrever; cota com função própria só para service_role", () => {
    const sql = readFileSync(
      join(
        __dirname,
        "../../../supabase/migrations/20261105180000_bots_auth_guard_v3.sql",
      ),
      "utf8",
    )
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).toMatch(/\('bots_auth_mode', 'observar'\)/);
    expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    // causa da falha da CI #42: ai_quota_add (V2) sem EXECUTE para service_role
    expect(sql).not.toMatch(/ai_quota_add/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.bots_quota_take\(uuid, integer\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.bots_quota_take\(uuid, integer\) TO service_role;/,
    );
    expect(sql).not.toMatch(/GRANT[^;]*\b(anon|authenticated|PUBLIC)\b/);
    expect(sql).toMatch(
      /SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/,
    );
    expect(sql).not.toMatch(/\b(DROP|ALTER|UPDATE public)\b/i);
    // DELETE só das reservas do juiz (linhas operacionais 'judge_lease:*')
    for (const del of sql.match(/DELETE FROM[^;]*;/g) ?? [])
      expect(del).toMatch(/^DELETE FROM public\.ai_quota\s+WHERE key = /);
    for (const fn of [
      "judge_lease_take(uuid, integer, integer)",
      "judge_lease_release(uuid, integer)",
    ]) {
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`,
      );
      expect(sql).toContain(
        `GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`,
      );
    }
    // a chave montada no banco é a mesma que a edge documenta
    expect(sql).toContain(
      "'bots_round:' || p_room_id::text || ':' || p_round::text",
    );
    expect(quotaKey(ROOM, 2)).toBe(`bots_round:${ROOM}:2`);
  });
});
