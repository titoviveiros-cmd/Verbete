import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// B6 — ECA Digital (Lei 15.211/2025 arts. 7º e 8º IV): ranking público só com
// opt-in, padrão desligado, desligar a qualquer momento; fim do alerta
// "streak em risco". A regra vale no banco (migration) e a interface só grava
// a escolha do titular. A suíte de integração scripts/test-ranking-optin.mjs
// prova o mesmo no Postgres real do CI.

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261111154500_ranking_opt_in.sql";
const ROLLBACK = "supabase/rollback/ranking_opt_in.sql";
/** SQL sem comentários e com espaços colapsados. */
const sql = (p: string) =>
  read(p)
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ");

const h = vi.hoisted(() => ({
  calls: [] as string[],
  updateArg: null as unknown,
  selectResult: { data: null as unknown, error: null as unknown },
  updateError: null as unknown,
  termsOk: true,
}));

vi.mock("@/lib/terms-consent", () => ({
  assertTermsAccepted: vi.fn(async () => {
    h.calls.push("assertTermsAccepted");
    if (!h.termsOk) throw new Error("aceite os Termos");
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, v: string) => ({
          maybeSingle: async () => {
            h.calls.push(`select ${table}.${cols} ${col}=${v}`);
            return h.selectResult;
          },
        }),
      }),
      update: (arg: unknown) => {
        h.updateArg = arg;
        return {
          eq: async (col: string, v: string) => {
            h.calls.push(`update ${table} ${col}=${v}`);
            return { error: h.updateError };
          },
        };
      },
    }),
  },
}));

import {
  RANKING_OPT_IN_COPY,
  fetchRankingOptIn,
  setRankingOptIn,
} from "@/lib/ranking-opt-in";

beforeEach(() => {
  h.calls = [];
  h.updateArg = null;
  h.selectResult = { data: null, error: null };
  h.updateError = null;
  h.termsOk = true;
});

describe("lib: escolha do titular", () => {
  it("lê a própria escolha; sem perfil ou com erro = null (nunca 'ligado')", async () => {
    h.selectResult = { data: { ranking_opt_in: true }, error: null };
    expect(await fetchRankingOptIn("u1")).toBe(true);
    h.selectResult = { data: { ranking_opt_in: false }, error: null };
    expect(await fetchRankingOptIn("u1")).toBe(false);
    h.selectResult = { data: null, error: null };
    expect(await fetchRankingOptIn("u1")).toBeNull();
    h.selectResult = { data: null, error: { message: "x" } };
    expect(await fetchRankingOptIn("u1")).toBeNull();
    expect(h.calls[0]).toBe("select profiles.ranking_opt_in user_id=u1");
  });

  it("ativar confere o aceite dos Termos ANTES de gravar", async () => {
    await setRankingOptIn("u1", true);
    expect(h.calls).toEqual([
      "assertTermsAccepted",
      "update profiles user_id=u1",
    ]);
    expect(h.updateArg).toEqual({ ranking_opt_in: true });
  });

  it("sem o aceite, ativar não grava nada", async () => {
    h.termsOk = false;
    await expect(setRankingOptIn("u1", true)).rejects.toThrow(/Termos/);
    expect(h.calls).toEqual(["assertTermsAccepted"]);
    expect(h.updateArg).toBeNull();
  });

  it("desativar nunca pede nada (a qualquer momento)", async () => {
    h.termsOk = false;
    await setRankingOptIn("u1", false);
    expect(h.calls).toEqual(["update profiles user_id=u1"]);
    expect(h.updateArg).toEqual({ ranking_opt_in: false });
  });

  it("erro do banco vira erro (a tela não finge que salvou)", async () => {
    h.updateError = { message: "rls" };
    await expect(setRankingOptIn("u1", false)).rejects.toThrow("rls");
  });

  it("o texto diz o que fica visível e que dá para desligar", () => {
    expect(RANKING_OPT_IN_COPY.on).toMatch(/nome, avatar e pontos/);
    expect(RANKING_OPT_IN_COPY.on).toMatch(/Desligue quando quiser/);
    expect(RANKING_OPT_IN_COPY.off).toMatch(/ninguém vê seu nome/);
  });
});

describe("migration: a regra está no banco", () => {
  const m = sql(MIGRATION);

  it("vem depois da última migration do pacote ECA (#65 = 20261111130000)", () => {
    const names = readdirSync(resolve(ROOT, "supabase/migrations")).sort();
    expect(MIGRATION.split("/").pop()! > "20261111130000").toBe(true);
    expect(names).toContain(MIGRATION.split("/").pop());
  });

  it("padrão desligado para TODOS (coluna NOT NULL DEFAULT false, sem backfill para true)", () => {
    expect(m).toMatch(
      /ADD COLUMN IF NOT EXISTS ranking_opt_in boolean NOT NULL DEFAULT false/,
    );
    expect(m).not.toMatch(/SET ranking_opt_in = true/i);
  });

  it("leitura direta de profiles: só o próprio ou quem optou (fim do USING (true))", () => {
    expect(m).toMatch(/DROP POLICY IF EXISTS "profiles authenticated read"/);
    expect(m).toMatch(
      /FOR SELECT TO authenticated USING \(auth\.uid\(\) = user_id OR ranking_opt_in\)/,
    );
    expect(m).not.toMatch(/USING \(true\)/);
  });

  it("Top 50 e Ranking de hoje filtram pelo opt-in (+ a própria linha)", () => {
    expect(m).toMatch(
      /JOIN public\.profiles p ON p\.user_id = s\.user_id WHERE s\.total_score > 0 AND \(p\.ranking_opt_in OR s\.user_id = auth\.uid\(\)\)/,
    );
    expect(m).not.toMatch(/LEFT JOIN public\.profiles/);
    expect(m).toMatch(
      /AND \(a\.user_id = auth\.uid\(\) OR EXISTS \(SELECT 1 FROM public\.profiles p WHERE p\.user_id = a\.user_id AND p\.ranking_opt_in\)\)/,
    );
  });

  it("APK vc8: mesmas assinaturas e colunas (CREATE OR REPLACE, sem DROP) e nenhum grant novo", () => {
    expect(m).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_ranking_top\(p_limit integer DEFAULT 50\) RETURNS TABLE \( user_id uuid, total_score integer, games_played integer, games_won integer, best_match_score integer, display_name text, avatar text, color text \)/,
    );
    expect(m).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_daily_leaderboard\(p_limit integer DEFAULT 20, p_mode text DEFAULT NULL\) RETURNS TABLE \(user_id uuid, score integer, is_correct boolean, time_seconds integer, mode text\)/,
    );
    expect(m).not.toMatch(/DROP FUNCTION/i);
    expect(m).not.toMatch(/\bGRANT\b/i);
    expect(m).not.toMatch(/\bREVOKE\b/i);
  });

  it("rollback volta ao estado anterior, na ordem certa", () => {
    const r = sql(ROLLBACK);
    expect(r).toMatch(
      /LEFT JOIN public\.profiles p ON p\.user_id = s\.user_id WHERE s\.total_score > 0 ORDER BY/,
    );
    expect(r).toMatch(
      /CREATE POLICY "profiles authenticated read" ON public\.profiles FOR SELECT TO authenticated USING \(true\)/,
    );
    expect(r).not.toMatch(/ranking_opt_in OR|AND p\.ranking_opt_in/);
    const drop = r.indexOf("DROP COLUMN IF EXISTS ranking_opt_in");
    expect(drop).toBeGreaterThan(r.indexOf("get_daily_leaderboard"));
    expect(drop).toBeGreaterThan(
      r.indexOf('CREATE POLICY "profiles authenticated read"'),
    );
    expect(r).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
  });

  it("a suíte de integração está registrada no CI", () => {
    expect(read("scripts/run-integration.mjs")).toMatch(
      /"test-ranking-optin\.mjs"/,
    );
  });
});

describe("interface", () => {
  it("o interruptor está no Ranking e no Perfil", () => {
    for (const f of ["src/routes/ranking.tsx", "src/routes/profile.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(
        /import \{ RankingOptIn \} from "@\/components\/RankingOptIn"/,
      );
      expect(src, f).toMatch(/<RankingOptIn\b[^>]*userId=\{user\.id\}/);
    }
  });

  it("o Ranking recarrega ao mudar a escolha e rotula a própria linha escondida", () => {
    const src = read("src/routes/ranking.tsx");
    expect(src).toMatch(/if \(source === "save"\) setReload/);
    expect(src).toMatch(/\[user, authLoading, nav, reload\]/);
    expect(src).toMatch(/só você vê/);
  });

  it("o interruptor segue o padrão do aceite (caixa + confirm) só ao LIGAR", () => {
    const src = read("src/components/RankingOptIn.tsx");
    expect(src).toMatch(/useTermsGate\(/);
    expect(src).toMatch(/<TermsConsent\b/);
    expect(src).toMatch(
      /if \(next\) \{\s*setAsked\(true\);\s*if \(!terms\.confirm\(\)\) return;/,
    );
    expect(src).toMatch(/role="switch"/);
  });

  it("sem alerta de 'streak em risco' nem pulso infinito na Home", () => {
    // só o código (o comentário do topo registra o que saiu)
    const src = read("src/components/HomeStatsCard.tsx").replace(
      /^\s*\/\/[^\n]*\n/gm,
      "",
    );
    expect(src).not.toMatch(/em risco/i);
    expect(src).not.toMatch(/atRisk/);
    expect(src).not.toMatch(/Infinity/);
    expect(src).not.toMatch(/Manter streak/);
    // a sequência continua visível (informação, sem cobrança)
    expect(src).toMatch(/Streak atual/);
  });
});
