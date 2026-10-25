import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VOTING_BASE_SECS,
  VOTING_EXTENSION_SECS,
  WRITING_BASE_SECS,
  WRITING_EXTENSION_SECS,
  WRITING_EXTRA_SECS,
  votingTimerMax,
  writingTimerMax,
} from "../game-times";

// Paridade cliente × servidor dos prazos (2026-10-25): a barra da votação
// usava base 40 contra 30 do servidor. As barras são o espelho do prazo real
// (round_phase_ends_at, gravado pelo banco): este teste lê a ÚLTIMA definição
// de cada função nas migrations e falha se um lado mudar sem o outro.
// Vitest roda na raiz do repositório (como semantic.test.ts)
const ROOT = process.cwd();
const DIR = join(ROOT, "supabase/migrations");
const SQL = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(DIR, f), "utf8"))
  .join("\n");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Corpo da última definição da função (a que vale no banco). */
function lastDef(name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`, "g");
  let at = -1;
  for (let m = re.exec(SQL); m; m = re.exec(SQL)) at = m.index;
  if (at < 0) throw new Error(`função ${name} não encontrada nas migrations`);
  const rest = SQL.slice(at + 1);
  const end = rest.search(
    /\n(CREATE OR REPLACE FUNCTION|REVOKE|GRANT|DROP |CREATE TRIGGER)/,
  );
  return SQL.slice(at, at + 1 + (end < 0 ? rest.length : end));
}
const num = (re: RegExp, text: string) => Number(text.match(re)?.[1]);
const pair = (text: string) => {
  const m = text.match(/THEN (\d+) ELSE (\d+) END/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

describe("votação: a barra do cliente = o prazo do servidor", () => {
  it("base da fase: advance_writing_to_voting e a volta da pausa usam a mesma do cliente", () => {
    expect(
      num(
        /phase_secs\(p_room_id, (\d+)\)/,
        lastDef("advance_writing_to_voting"),
      ),
    ).toBe(VOTING_BASE_SECS);
    expect(
      num(
        /WHEN 'voting' THEN now\(\) \+ make_interval\(secs => public\.phase_secs\(p_room_id, (\d+)\)\)/,
        lastDef("resume_paused_room"),
      ),
    ).toBe(VOTING_BASE_SECS);
  });

  it("prorrogação: mesmos degraus e escalada pela sala, como no cliente", () => {
    const ext = lastDef("extend_voting_or_advance");
    expect(pair(ext)).toEqual([...VOTING_EXTENSION_SECS]);
    expect(ext).toContain("public.phase_secs(p_room_id, v_extension_seconds)");
  });

  it("fator de sala igual: máx(1, mín(12, n)/6), arredondado", () => {
    const f = lastDef("phase_secs");
    expect(f).toMatch(
      /round\(p_base \* GREATEST\(1\.0, LEAST\(12, count\(\*\)\)::numeric \/ 6\.0\)\)/,
    );
  });

  it("4/6/7/8/10/12 jogadores → 30/30/35/40/50/60 s (antes a barra dava 40/40/47/53/67/80)", () => {
    expect([4, 6, 7, 8, 10, 12].map((n) => votingTimerMax(0, n))).toEqual([
      30, 30, 35, 40, 50, 60,
    ]);
    expect(votingTimerMax(1, 12)).toBe(40);
    expect(votingTimerMax(2, 12)).toBe(30);
  });
});

describe("escrita: tempo fixo nos dois lados", () => {
  it("writing_phase_secs = base + 10 s e as portas de entrada usam a base do cliente", () => {
    expect(num(/p_base \+ (\d+)/, lastDef("writing_phase_secs"))).toBe(
      WRITING_EXTRA_SECS,
    );
    expect(
      num(
        /writing_phase_secs\((\d+)\)/,
        lastDef("advance_choosing_to_writing"),
      ),
    ).toBe(WRITING_BASE_SECS);
    expect(
      num(
        /WHEN 'writing' THEN now\(\) \+ make_interval\(secs => public\.writing_phase_secs\((\d+)\)\)/,
        lastDef("resume_paused_room"),
      ),
    ).toBe(WRITING_BASE_SECS);
    expect(lastDef("choose_word")).toContain(
      "public.writing_phase_secs(p_duration_sec)",
    );
    expect(writingTimerMax(0)).toBe(WRITING_BASE_SECS + WRITING_EXTRA_SECS);
  });

  it("prorrogação da escrita: mesmos degraus e SEM escalar com a sala", () => {
    const ext = lastDef("extend_writing_or_advance");
    expect(pair(ext)).toEqual([...WRITING_EXTENSION_SECS]);
    expect(ext).not.toContain("phase_secs(");
  });
});

describe("as telas usam as funções canônicas (sem fórmula duplicada)", () => {
  it("Votação → votingTimerMax; Escrita → writingTimerMax", () => {
    const voting = src("src/components/room/phases/Voting.tsx");
    const writing = src("src/components/room/phases/WriteDefinition.tsx");
    expect(voting).toContain("votingTimerMax(");
    expect(voting).not.toContain("scalePhaseSecs(");
    expect(writing).toContain("writingTimerMax(");
    expect(writing).not.toContain("scalePhaseSecs(");
  });
});
