// D1 — R6b: a função antiga daily_choice_admin_review NÃO aprova mais (só reprova ou volta
// a rascunho); aprovar = daily_choice_admin_review_hashed (R1). Testa a migration
// 20261110180000_d1_r6b_aprovar_so_por_hash.sql e o rollback dela.
//
//   node scripts/test-daily-choice-r6b.mjs --pglite <pasta do @electric-sql/pglite>
//       Offline (1 conexão): esquema MÍNIMO com a tabela e as funções REAIS do D1 + R1,
//       aplica a R6b, testa, aplica o rollback (volta byte a byte) e reaplica. Sem corrida.
//   DB_URL=postgres://…127.0.0.1… node scripts/test-daily-choice-r6b.mjs        (CI)
//       Supabase local já migrado: roda também a CORRIDA com conexões independentes.
//       Só aceita banco LOCAL; apaga o que criou.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const D1 = rd("supabase/migrations/20261108120000_diario_d1_escolha.sql");
const R1 = rd("supabase/migrations/20261110120000_d1_hash_no_banco.sql");
const R6B = rd("supabase/migrations/20261110180000_d1_r6b_aprovar_so_por_hash.sql");
const R6B_ROLLBACK = rd("supabase/rollback/d1_r6b_aprovar_so_por_hash.sql");

const args = process.argv.slice(2);
const pglitePath = args.includes("--pglite") ? args[args.indexOf("--pglite") + 1] : null;
const modePg = !pglitePath;
const DB_URL = process.env.DB_URL ?? process.env.DATABASE_URL;
if (modePg) {
  if (!DB_URL) {
    console.error("✖ DB_URL ausente: este teste NÃO pode passar sem um Postgres real (use --pglite só para o ensaio local).");
    process.exit(1);
  }
  const host = new URL(DB_URL).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    console.error(`✖ recusado: DB_URL aponta para "${host}". Este teste altera dados e só roda em banco LOCAL.`);
    process.exit(1);
  }
}

let db;
if (modePg) {
  const { default: pg } = await import("pg");
  const mk = async () => {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    return c;
  };
  const main = await mk();
  db = { q: async (s, p = []) => (await main.query(s, p)).rows, exec: (s) => main.query(s), close: () => main.end(), conn: mk };
} else {
  const { PGlite } = await import(pathToFileURL(join(pglitePath, "dist", "index.js")).href);
  const pgl = await PGlite.create();
  db = { q: async (s, p = []) => (await pgl.query(s, p)).rows, exec: (s) => pgl.exec(s), close: () => pgl.close(), conn: null };
}

let pass = 0;
let fail = 0;
async function t(nome, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✔ ${nome}`);
  } catch (e) {
    fail++;
    console.log(`  ✖ ${nome}\n      ${e?.message ?? e}`);
  }
}
/** jsonb devolve as chaves ordenadas: compara sem depender da ordem das chaves. */
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const eq = (a, b, msg) => {
  if (JSON.stringify(canon(a)) !== JSON.stringify(canon(b))) throw new Error(`${msg ?? "diferente"}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
};
const ok = (v, msg) => {
  if (!v) throw new Error(msg ?? "falso");
};
const NL = String.fromCharCode(10);
const hashNode = (id, truth, ds) =>
  createHash("sha256").update(["verbete-d1-v1", id, truth, ...ds.map((d) => d.trim())].join(NL), "utf8").digest("hex");
const fnBlock = (src, start, endMark) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`não achei: ${start}`);
  return src.slice(i, src.indexOf(endMark, i) + endMark.length);
};
const md5Review = async () =>
  (await db.q(`SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'daily_choice_admin_review'`))[0]?.m;
/** Código SQLSTATE do erro (pg e PGlite expõem .code). null = não deu erro. */
const codigoErro = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return String(e?.code ?? e?.message ?? e);
  }
  return null;
};

// ---------------------------------------------------------------------------
// Esquema mínimo (só PGlite): tabela + funções REAIS do D1, a R1 e então a R6b
// ---------------------------------------------------------------------------
let original = null; // md5 do corpo antigo (D1), para o rollback voltar byte a byte
if (!modePg) {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.words (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), word text NOT NULL UNIQUE, meaning text NOT NULL,
      category text, rarity int NOT NULL DEFAULT 2, classe text, status text NOT NULL DEFAULT 'published');
    ${fnBlock(D1, "CREATE TABLE IF NOT EXISTS public.daily_choice_sets", ");")}
    ${fnBlock(D1, "CREATE OR REPLACE FUNCTION public.daily_choice_admin_review", "END $$;")}
    REVOKE ALL ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) TO service_role;
  `);
  await db.exec(fnBlock(D1, "CREATE OR REPLACE FUNCTION public.daily_choice_admin_edit", "END $$;"));
  await db.exec(fnBlock(D1, "CREATE OR REPLACE FUNCTION public.daily_choice_admin_get", "$$;"));
  await db.exec(fnBlock(D1, "CREATE OR REPLACE FUNCTION public.daily_choice_admin_add_drafts", "END $$;"));
  await db.exec(R1);
  original = await md5Review();
  await db.exec(R6B);
}
console.log(`D1 — R6b (função antiga não aprova) — modo ${modePg ? "pg (Postgres real)" : "PGlite (offline, 1 conexão)"}`);

// ---------------------------------------------------------------------------
// Dados do teste (palavras próprias, apagadas no fim)
// ---------------------------------------------------------------------------
const tag = randomUUID().slice(0, 8);
const palavras = [];
const REVISOR = randomUUID();
const ALTS = ["perda absoluta ou parcial da vontade", "aumento do volume de um órgão ou tecido", "contração muscular involuntária e visível sob a pele"];
const TRUTH = "perda ou diminuição dos movimentos voluntários";
/** Palavra publicada + conjunto em `status`, validador OK e tudo apto a aprovar. */
async function conjunto(status = "rascunho") {
  const [w] = await db.q(`INSERT INTO public.words (word, meaning, rarity, status) VALUES ($1, $2, 3, 'published') RETURNING id`,
    [`zz-teste-r6b-${tag}-${palavras.length}`, TRUTH]);
  palavras.push(w.id);
  await db.q(`INSERT INTO public.daily_choice_sets (word_id, distractors, truth_snapshot, status, validacao)
              VALUES ($1, $2, $3, $4, '{"ok":true}')`, [w.id, ALTS, TRUTH, status]);
  return w.id;
}
const linha = async (id) =>
  (await db.q(`SELECT status, reviewed_by IS NOT NULL AS rb, reviewed_at IS NOT NULL AS ra FROM public.daily_choice_sets WHERE word_id = $1`, [id]))[0];
const antiga = (ids, status, reviewer = REVISOR, q = db.q) =>
  q(`SELECT public.daily_choice_admin_review($1::uuid[], $2, $3) AS r`, [ids, status, reviewer]).then((r) => r[0].r);
const porHash = (ids, q = db.q) =>
  q(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, $2) AS r`,
    [JSON.stringify(Object.fromEntries(ids.map((id) => [id, hashNode(id, TRUTH, ALTS)]))), REVISOR]).then((r) => r[0].r);

try {
  await t("R6b: 'aprovado' pela função antiga é RECUSADO (42501) e nada é gravado — mesmo com tudo apto", async () => {
    const a = await conjunto();
    const b = await conjunto();
    eq(await codigoErro(() => antiga([a, b], "aprovado")), "42501");
    eq(await linha(a), { status: "rascunho", rb: false, ra: false });
    eq(await linha(b), { status: "rascunho", rb: false, ra: false });
  });

  await t("R6b: a recusa vem antes de qualquer outra regra (lote vazio, revisor nulo, >200)", async () => {
    const a = await conjunto();
    eq(await codigoErro(() => antiga([], "aprovado")), "42501");
    eq(await codigoErro(() => antiga([a], "aprovado", null)), "42501");
    const muitos = Array.from({ length: 201 }, () => randomUUID());
    eq(await codigoErro(() => antiga(muitos, "aprovado")), "42501");
    eq((await linha(a)).status, "rascunho");
  });

  await t("reprovar segue igual: rascunho e aprovado → reprovado, com revisor e data", async () => {
    const a = await conjunto();
    const b = await conjunto("aprovado");
    eq(await antiga([a, b], "reprovado"), { updated: 2, skipped: 0 });
    eq(await linha(a), { status: "reprovado", rb: true, ra: true });
    eq(await linha(b), { status: "reprovado", rb: true, ra: true });
  });

  await t("voltar a rascunho segue igual: limpa revisor e data", async () => {
    const a = await conjunto("reprovado");
    await db.q(`UPDATE public.daily_choice_sets SET reviewed_by = $2, reviewed_at = now() WHERE word_id = $1`, [a, REVISOR]);
    eq(await antiga([a], "rascunho"), { updated: 1, skipped: 0 });
    eq(await linha(a), { status: "rascunho", rb: false, ra: false });
  });

  await t("entradas inválidas recusadas inteiras (22023; status NULL agora também, antes escapava); id inexistente = pulado", async () => {
    const a = await conjunto();
    for (const s of [null, "APROVADO", "Aprovado ", "publicado", ""])
      eq(await codigoErro(() => antiga([a], s)), "22023", `status ${JSON.stringify(s)}`);
    eq(await codigoErro(() => antiga([], "reprovado")), "22023", "lote vazio");
    eq(await codigoErro(() => antiga([a], "reprovado", null)), "22023", "revisor nulo");
    eq(await codigoErro(() => antiga(Array.from({ length: 201 }, () => randomUUID()), "reprovado")), "22023", ">200");
    eq((await linha(a)).status, "rascunho");
    eq(await antiga([a, randomUUID()], "reprovado"), { updated: 1, skipped: 1 });
  });

  await t("o caminho certo continua: rascunho → aprovado por hash (R1); reprovado volta a rascunho e aí aprova", async () => {
    const a = await conjunto();
    const b = await conjunto("reprovado");
    eq(await porHash([a, b]), { updated: 1, skipped: 1 });
    eq((await linha(a)).status, "aprovado");
    eq((await linha(b)).status, "reprovado");
    await antiga([b], "rascunho");
    eq(await porHash([b]), { updated: 1, skipped: 0 });
    eq(await linha(b), { status: "aprovado", rb: true, ra: true });
  });

  await t("assinatura, retorno, SECURITY DEFINER e search_path iguais; permissões só service_role", async () => {
    const [f] = await db.q(`SELECT pg_get_function_identity_arguments(p.oid) AS a, pg_get_function_result(p.oid) AS r,
                                   p.prosecdef AS d, p.proconfig AS c, p.oid::regprocedure::text AS sig
                              FROM pg_proc p WHERE p.proname = 'daily_choice_admin_review'`);
    eq(f.a, "p_word_ids uuid[], p_status text, p_reviewer uuid");
    eq(f.r, "jsonb");
    eq(f.d, true);
    ok(String(f.c).includes("search_path=public, pg_temp"), `search_path: ${f.c}`);
    eq((await db.q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'daily_choice_admin_review'`))[0].n, 1, "uma só sobrecarga");
    for (const [papel, pode] of [["anon", false], ["authenticated", false], ["service_role", true]])
      eq((await db.q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS p`, [papel, f.sig]))[0].p, pode, papel);
  });

  // só no PGlite: no pg (CI) o banco é compartilhado pelas suítes e já recebeu a migration
  if (!modePg) await t("reaplicar a migration é idempotente (mesmo corpo, mesmas permissões)", async () => {
    const m = await md5Review();
    await db.exec(R6B);
    eq(await md5Review(), m);
    eq((await db.q(`SELECT has_function_privilege('authenticated', 'public.daily_choice_admin_review(uuid[],text,uuid)', 'EXECUTE') AS p`))[0].p, false);
  });

  if (!modePg) {
    await t("pré-condição: sem a R1 (aprovação por hash) a migration se recusa a rodar", async () => {
      await db.exec("ALTER FUNCTION public.daily_choice_admin_review_hashed(jsonb, uuid) RENAME TO zz_r6b_tmp");
      try {
        ok(await codigoErro(() => db.exec(R6B)), "aplicou sem a R1");
      } finally {
        await db.exec("ALTER FUNCTION public.zz_r6b_tmp(jsonb, uuid) RENAME TO daily_choice_admin_review_hashed");
      }
    });
    await t("rollback: volta o corpo antigo BYTE A BYTE (aprovar sem hash reabre), permissões iguais; reaplicar fecha de novo", async () => {
      await db.exec(R6B_ROLLBACK);
      eq(await md5Review(), original, "corpo depois do rollback");
      const a = await conjunto();
      eq(await antiga([a], "aprovado"), { updated: 1, skipped: 0 });
      eq((await db.q(`SELECT has_function_privilege('anon', 'public.daily_choice_admin_review(uuid[],text,uuid)', 'EXECUTE') AS p`))[0].p, false);
      await db.exec(R6B);
      const b = await conjunto();
      eq(await codigoErro(() => antiga([b], "aprovado")), "42501");
    });
  }

  if (modePg) {
    await t("corrida: aprovação por hash em andamento × reprovação → a reprovação espera e vale por último", async () => {
      const a = await conjunto();
      const c1 = await db.conn();
      const c2 = await db.conn();
      try {
        await c1.query("BEGIN");
        await porHash([a], (s, p) => c1.query(s, p).then((r) => r.rows));
        let terminou = false;
        const reprovando = antiga([a], "reprovado", REVISOR, (s, p) => c2.query(s, p).then((r) => r.rows)).then((r) => {
          terminou = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 400));
        ok(!terminou, "a reprovação não esperou a trava da aprovação");
        await c1.query("COMMIT");
        eq(await reprovando, { updated: 1, skipped: 0 });
        eq((await linha(a)).status, "reprovado");
      } finally {
        await c1.end();
        await c2.end();
      }
    });
  }
} finally {
  if (modePg && palavras.length) {
    await db.q(`DELETE FROM public.daily_choice_sets WHERE word_id = ANY($1::uuid[])`, [palavras]);
    await db.q(`DELETE FROM public.words WHERE id = ANY($1::uuid[])`, [palavras]);
  }
  await db.close();
}
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
