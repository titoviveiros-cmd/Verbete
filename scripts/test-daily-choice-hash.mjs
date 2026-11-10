// D1 — hash conferido DENTRO do banco (R1) + trava de edição de aprovado (R3) + R2 no banco.
// Testa a migration 20261110120000_d1_hash_no_banco.sql.
//
//   node scripts/test-daily-choice-hash.mjs --pglite <pasta do @electric-sql/pglite>
//       Offline (1 conexão): esquema MÍNIMO com a tabela e as funções antigas REAIS do D1,
//       aplica a migration nova e confere que as antigas não mudaram. Sem a corrida.
//   DB_URL=postgres://…127.0.0.1… node scripts/test-daily-choice-hash.mjs        (CI)
//       Supabase local já migrado: roda também as CORRIDAS com conexões independentes
//       (edição × aprovação ao mesmo tempo). Só aceita banco LOCAL; apaga o que criou.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const D1 = rd("supabase/migrations/20261108120000_diario_d1_escolha.sql");
const NOVA = rd("supabase/migrations/20261110120000_d1_hash_no_banco.sql");
const ROLLBACK = rd("supabase/rollback/d1_hash_no_banco.sql");

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
/** O MESMO cálculo de setHash() (src/lib/daily-choice-manifest.ts) e do script offline de revisão. */
const hashNode = (id, truth, ds) =>
  createHash("sha256").update(["verbete-d1-v1", id, truth, ...ds.map((d) => d.trim())].join(NL), "utf8").digest("hex");
const fnBlock = (src, start, endMark) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`não achei: ${start}`);
  return src.slice(i, src.indexOf(endMark, i) + endMark.length);
};
const ANTIGAS = ["daily_choice_admin_review", "daily_choice_admin_edit", "daily_choice_admin_get", "daily_choice_admin_add_drafts"];
const md5Antigas = async () =>
  (await db.q(`SELECT proname, md5(prosrc) AS m FROM pg_proc WHERE proname = ANY($1) ORDER BY proname`, [ANTIGAS]));

// ---------------------------------------------------------------------------
// Esquema mínimo (só PGlite): tabela e funções antigas REAIS do D1, depois a nova
// ---------------------------------------------------------------------------
let antes = null;
if (!modePg) {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.words (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), word text NOT NULL UNIQUE, meaning text NOT NULL,
      category text, rarity int NOT NULL DEFAULT 2, classe text, status text NOT NULL DEFAULT 'published');
    ${fnBlock(D1, "CREATE TABLE IF NOT EXISTS public.daily_choice_sets", ");")}
    ${fnBlock(D1, "CREATE OR REPLACE FUNCTION public.daily_choice_admin_get", "$$;")}
    ${fnBlock(D1, "CREATE OR REPLACE FUNCTION public.daily_choice_admin_add_drafts", "END $$;")}
    ${fnBlock(D1, "CREATE OR REPLACE FUNCTION public.daily_choice_admin_edit", "END $$;")}
    ${fnBlock(D1, "CREATE OR REPLACE FUNCTION public.daily_choice_admin_review", "END $$;")}
  `);
  antes = await md5Antigas();
  await db.exec(NOVA);
}
console.log(`D1 — hash no banco (R1/R2/R3) — modo ${modePg ? "pg (Postgres real)" : "PGlite (offline, 1 conexão)"}`);

// ---------------------------------------------------------------------------
// Dados do teste (palavras próprias, apagadas no fim)
// ---------------------------------------------------------------------------
const tag = randomUUID().slice(0, 8);
const palavras = [];
const REVISOR = randomUUID();
const ALTS = ["perda absoluta ou parcial da vontade", "aumento do volume de um órgão ou tecido", "contração muscular involuntária e visível sob a pele"];
const OUTRAS = ["ave marinha de bico longo", ALTS[1], ALTS[2]];
const TRUTH = "perda ou diminuição dos movimentos voluntários";
/** Palavra publicada + conjunto em `status` com validador OK. */
async function conjunto(status = "rascunho", alts = ALTS, over = {}) {
  const [w] = await db.q(`INSERT INTO public.words (word, meaning, rarity, status) VALUES ($1, $2, 3, $3) RETURNING id`,
    [`zz-teste-hash-${tag}-${palavras.length}`, over.meaning ?? TRUTH, over.wordStatus ?? "published"]);
  palavras.push(w.id);
  await db.q(`INSERT INTO public.daily_choice_sets (word_id, distractors, truth_snapshot, status, validacao)
              VALUES ($1, $2, $3, $4, $5)`,
    [w.id, alts, over.snapshot ?? over.meaning ?? TRUTH, status, JSON.stringify({ ok: over.validOk ?? true })]);
  return w.id;
}
const estado = async (id) => (await db.q(`SELECT status, distractors FROM public.daily_choice_sets WHERE word_id = $1`, [id]))[0];
const aprovar = async (expected, q = db.q) =>
  (await q(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, $2) AS r`, [JSON.stringify(expected), REVISOR]))[0].r;
const editar = async (id, alts, allow, allowRejected = false, q = db.q) =>
  (await q(`SELECT public.daily_choice_admin_edit_guarded($1, $2, '{"ok":true}'::jsonb, $3, $4) AS r`, [id, alts, allow, allowRejected]))[0].r;
const erroSql = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return String(e?.message ?? e);
  }
  return null;
};

try {
  await t("hash do banco = hash do Worker: vetor fixo v1 (o mesmo do teste TS)", async () => {
    const [{ h }] = await db.q(`SELECT public.daily_choice_set_hash($1, $2, $3) AS h`,
      ["00000000-0000-4000-8000-000000000001", TRUTH, ALTS]);
    eq(h, "480b989b9cb845dd3a5e6baa9d9e3f9977fcd1b2e1dc99e06860ca79c89e1d5b");
  });

  await t("hash do banco = hash do Worker: acentos, aspas, travessão, emoji e definição com quebra", async () => {
    const casos = [
      [randomUUID(), "ação — “pé” ‘ç’ ü", ["à", "é ñ", "😀 x"]],
      [randomUUID(), `definição de${NL}duas linhas`, ["um", "dois", "três"]],
      [randomUUID(), "x".repeat(2000), ["a'b", "c\\d", "e;f--g"]],
    ];
    for (const [id, truth, ds] of casos) {
      const [{ h }] = await db.q(`SELECT public.daily_choice_set_hash($1, $2, $3) AS h`, [id, truth, ds]);
      eq(h, hashNode(id, truth, ds), `caso ${truth.slice(0, 12)}`);
    }
  });

  await t("hash com alternativa nula ou sem 3 alternativas = NULL (nunca confere)", async () => {
    const [{ a, b }] = await db.q(`SELECT public.daily_choice_set_hash($1, 'x', ARRAY['a', NULL, 'c']) AS a,
                                          public.daily_choice_set_hash($1, 'x', ARRAY['a','b']) AS b`, [randomUUID()]);
    eq([a, b], [null, null]);
  });

  await t("R2 no banco: quebra de linha, controle e U+2028 recusados; texto comum aceito", async () => {
    const [r] = await db.q(`SELECT public.daily_choice_alt_ok(ARRAY['a','b','c']) AS bom,
                                   public.daily_choice_alt_ok(ARRAY[E'a\\nb','b','c']) AS nl,
                                   public.daily_choice_alt_ok(ARRAY[E'a\\tb','b','c']) AS tab,
                                   public.daily_choice_alt_ok(ARRAY[E'a\\rb','b','c']) AS cr,
                                   public.daily_choice_alt_ok(ARRAY[E'a\\u2028b','b','c']) AS ls,
                                   public.daily_choice_alt_ok(ARRAY[E'a\\x7fb','b','c']) AS del,
                                   public.daily_choice_alt_ok(ARRAY['ação — “pé”','b','c']) AS acento,
                                   public.daily_choice_alt_ok(ARRAY['a','b']) AS dois,
                                   public.daily_choice_alt_ok(ARRAY['a','','c']) AS vazio`);
    eq(r, { bom: true, nl: false, tab: false, cr: false, ls: false, del: false, acento: true, dois: false, vazio: false });
  });

  await t("R1: aprova SÓ o que bate com o revisado; o resto fica como estava", async () => {
    const bom = await conjunto();
    const trocado = await conjunto("rascunho", OUTRAS);
    const r = await aprovar({ [bom]: hashNode(bom, TRUTH, ALTS), [trocado]: hashNode(trocado, TRUTH, ALTS) });
    eq(r, { updated: 1, skipped: 1 });
    eq((await estado(bom)).status, "aprovado");
    eq((await estado(trocado)).status, "rascunho");
    const [{ reviewed_by }] = await db.q(`SELECT reviewed_by FROM public.daily_choice_sets WHERE word_id = $1`, [bom]);
    eq(reviewed_by, REVISOR);
  });

  await t("R1: mantém as regras antigas (publicada, definição igual à revisada, validador OK)", async () => {
    const naoPub = await conjunto("rascunho", ALTS, { wordStatus: "draft" });
    const defMudou = await conjunto("rascunho", ALTS, { meaning: "definição nova", snapshot: TRUTH });
    const invalido = await conjunto("rascunho", ALTS, { validOk: false });
    const r = await aprovar({
      [naoPub]: hashNode(naoPub, TRUTH, ALTS),
      [defMudou]: hashNode(defMudou, "definição nova", ALTS),
      [invalido]: hashNode(invalido, TRUTH, ALTS),
    });
    eq(r, { updated: 0, skipped: 3 });
  });

  await t("R4 no banco: REPROVADO (e já aprovado) não é reaprovado pelo lote", async () => {
    const rep = await conjunto("reprovado");
    const apr = await conjunto("aprovado");
    eq(await aprovar({ [rep]: hashNode(rep, TRUTH, ALTS), [apr]: hashNode(apr, TRUTH, ALTS) }), { updated: 0, skipped: 2 });
    eq((await estado(rep)).status, "reprovado");
  });

  await t("R2 no banco: conjunto antigo com quebra de linha não é aprovado nem com o hash certo", async () => {
    const ruins = [`a${NL}b`, "c", "d"];
    const id = await conjunto("rascunho", ruins);
    const h = createHash("sha256").update(["verbete-d1-v1", id, TRUTH, ...ruins].join(NL), "utf8").digest("hex");
    eq(await aprovar({ [id]: h }), { updated: 0, skipped: 1 });
  });

  await t("R1: id inexistente conta como pulado; entrada inválida é recusada inteira", async () => {
    eq(await aprovar({ [randomUUID()]: "a".repeat(64) }), { updated: 0, skipped: 1 });
    const id = await conjunto();
    const ruins = [
      {},
      { [id]: "A".repeat(64) },
      { [id]: "abc" },
      { [id.toUpperCase()]: "a".repeat(64) },
      { "nao-uuid": "a".repeat(64) },
      { [id]: 5 },
      Object.fromEntries(Array.from({ length: 201 }, () => [randomUUID(), "a".repeat(64)])),
    ];
    for (const e of ruins) ok(/entrada inválida/.test((await erroSql(() => aprovar(e))) ?? ""), `aceitou ${JSON.stringify(e).slice(0, 60)}`);
    ok(/entrada inválida/.test((await erroSql(() =>
      db.q(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, NULL)`, [JSON.stringify({ [id]: "a".repeat(64) })]))) ?? ""));
    eq((await estado(id)).status, "rascunho");
  });

  await t("R3/R4 no banco: APROVADO e REPROVADO só mudam com pedido explícito; rascunho edita normal", async () => {
    const apr = await conjunto("aprovado");
    eq(await editar(apr, OUTRAS, false), { updated: 0, blocked: "aprovado" });
    eq(await editar(apr, OUTRAS, null), { updated: 0, blocked: "aprovado" });
    eq(await estado(apr), { status: "aprovado", distractors: ALTS });
    eq(await editar(apr, OUTRAS, true), { updated: 1 });
    eq(await estado(apr), { status: "rascunho", distractors: OUTRAS });
    const ras = await conjunto("rascunho");
    eq(await editar(ras, OUTRAS, false), { updated: 1 });
    // R4 por tabela: REPROVADO também só com pedido explícito (senão voltaria ao lote de aprovação)
    const rep = await conjunto("reprovado");
    eq(await editar(rep, OUTRAS, false), { updated: 0, blocked: "reprovado" });
    eq(await editar(rep, OUTRAS, true, null), { updated: 0, blocked: "reprovado" });
    eq(await estado(rep), { status: "reprovado", distractors: ALTS });
    eq(await editar(rep, OUTRAS, false, true), { updated: 1 });
    eq((await estado(rep)).status, "rascunho");
    eq(await editar(randomUUID(), OUTRAS, true), { updated: 0 });
  });

  await t("R2 na edição: alternativa com quebra de linha não é gravada", async () => {
    const id = await conjunto();
    ok(/sem quebra de linha/.test((await erroSql(() => editar(id, [`a${NL}b`, "c", "d"], true))) ?? ""));
    eq((await estado(id)).distractors, ALTS);
  });

  await t("R6 no banco: REPROVADO com o hash certo não é aprovado; volta a rascunho (sem hash) e aí aprova por hash", async () => {
    const id = await conjunto("reprovado");
    const h = hashNode(id, TRUTH, ALTS);
    eq(await aprovar({ [id]: h }), { updated: 0, skipped: 1 });
    eq((await estado(id)).status, "reprovado");
    const [{ r }] = await db.q(`SELECT public.daily_choice_admin_review($1::uuid[], 'rascunho', $2) AS r`, [[id], REVISOR]);
    eq(r, { updated: 1, skipped: 0 });
    eq(await aprovar({ [id]: h }), { updated: 1, skipped: 0 });
    eq((await estado(id)).status, "aprovado");
  });

  await t("R6 no banco: aprovar de novo um APROVADO não reescreve revisor nem data", async () => {
    const id = await conjunto();
    const h = hashNode(id, TRUTH, ALTS);
    eq(await aprovar({ [id]: h }), { updated: 1, skipped: 0 });
    const [antes1] = await db.q(`SELECT reviewed_by, reviewed_at FROM public.daily_choice_sets WHERE word_id = $1`, [id]);
    const outro = randomUUID();
    const [{ r }] = await db.q(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, $2) AS r`, [JSON.stringify({ [id]: h }), outro]);
    eq(r, { updated: 0, skipped: 1 });
    const [depois] = await db.q(`SELECT reviewed_by, reviewed_at FROM public.daily_choice_sets WHERE word_id = $1`, [id]);
    eq(String(depois.reviewed_by), String(antes1.reviewed_by));
    eq(String(depois.reviewed_at), String(antes1.reviewed_at));
  });

  await t("permissões: só service_role executa as funções novas", async () => {
    const fns = ["daily_choice_set_hash(uuid,text,text[])", "daily_choice_alt_ok(text[])",
      "daily_choice_admin_review_hashed(jsonb,uuid)", "daily_choice_admin_edit_guarded(uuid,text[],jsonb,boolean,boolean)"];
    for (const f of fns) {
      const [r] = await db.q(`SELECT has_function_privilege('anon', 'public.${f}', 'EXECUTE') AS anon,
                                     has_function_privilege('authenticated', 'public.${f}', 'EXECUTE') AS auth,
                                     has_function_privilege('service_role', 'public.${f}', 'EXECUTE') AS srv`);
      eq(r, { anon: false, auth: false, srv: true }, f);
    }
  });

  if (!modePg) {
    await t("compatibilidade: as funções antigas ficaram byte a byte iguais", async () => {
      eq(await md5Antigas(), antes);
    });
    await t("compatibilidade: a aprovação antiga (sem hash) segue igual depois da migration", async () => {
      const id = await conjunto();
      const [{ r }] = await db.q(`SELECT public.daily_choice_admin_review($1::uuid[], 'aprovado', $2) AS r`, [[id], REVISOR]);
      eq(r, { updated: 1, skipped: 0 });
    });
    await t("rollback: remove só as 4 funções novas; as antigas continuam e funcionam", async () => {
      await db.exec(ROLLBACK);
      const [{ n }] = await db.q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN
        ('daily_choice_set_hash','daily_choice_alt_ok','daily_choice_admin_review_hashed','daily_choice_admin_edit_guarded')`);
      eq(n, 0);
      eq(await md5Antigas(), antes);
      const id = await conjunto();
      const [{ r }] = await db.q(`SELECT public.daily_choice_admin_edit($1, $2, '{"ok":true}') AS r`, [id, OUTRAS]);
      eq(r, { updated: 1 });
      await db.exec(NOVA); // reaplicável
    });
  }

  if (modePg) {
    // Corridas com conexões REAIS independentes: o que a R1 fecha.
    await t("corrida: edição em andamento × aprovação por hash → a aprovação espera e NÃO aprova o trocado", async () => {
      const id = await conjunto();
      const a = await db.conn();
      const b = await db.conn();
      try {
        await a.query("BEGIN");
        await a.query(`SELECT public.daily_choice_admin_edit_guarded($1, $2, '{"ok":true}'::jsonb, false, false)`, [id, OUTRAS]);
        let terminou = false;
        const pb = b.query(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, $2) AS r`,
          [JSON.stringify({ [id]: hashNode(id, TRUTH, ALTS) }), REVISOR]).then((x) => ((terminou = true), x));
        await new Promise((r) => setTimeout(r, 400));
        ok(!terminou, "a aprovação não esperou a edição terminar (sem trava)");
        await a.query("COMMIT");
        const rb = (await pb).rows[0].r;
        eq(rb, { updated: 0, skipped: 1 });
        eq(await estado(id), { status: "rascunho", distractors: OUTRAS });
      } finally {
        await a.end();
        await b.end();
      }
    });

    await t("corrida: aprovação em andamento × Substituir sem pedido → a edição espera e é RECUSADA", async () => {
      const id = await conjunto();
      const a = await db.conn();
      const b = await db.conn();
      try {
        await a.query("BEGIN");
        await a.query(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, $2)`,
          [JSON.stringify({ [id]: hashNode(id, TRUTH, ALTS) }), REVISOR]);
        let terminou = false;
        const pb = b.query(`SELECT public.daily_choice_admin_edit_guarded($1, $2, '{"ok":true}'::jsonb, false, false) AS r`, [id, OUTRAS])
          .then((x) => ((terminou = true), x));
        await new Promise((r) => setTimeout(r, 400));
        ok(!terminou, "a edição não esperou a aprovação terminar (sem trava)");
        await a.query("COMMIT");
        eq((await pb).rows[0].r, { updated: 0, blocked: "aprovado" });
        eq(await estado(id), { status: "aprovado", distractors: ALTS });
      } finally {
        await a.end();
        await b.end();
      }
    });

    await t("R6 corrida: reprovação em andamento × aprovação do painel por hash → espera e NÃO aprova o reprovado", async () => {
      const id = await conjunto();
      const a = await db.conn();
      const b = await db.conn();
      try {
        await a.query("BEGIN");
        await a.query(`SELECT public.daily_choice_admin_review($1::uuid[], 'reprovado', $2)`, [[id], REVISOR]);
        let terminou = false;
        const pb = b.query(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, $2) AS r`,
          [JSON.stringify({ [id]: hashNode(id, TRUTH, ALTS) }), REVISOR]).then((x) => ((terminou = true), x));
        await new Promise((r) => setTimeout(r, 400));
        ok(!terminou, "a aprovação não esperou a reprovação terminar (sem trava)");
        await a.query("COMMIT");
        eq((await pb).rows[0].r, { updated: 0, skipped: 1 });
        eq((await estado(id)).status, "reprovado");
      } finally {
        await a.end();
        await b.end();
      }
    });

    await t("R6 corrida: duas aprovações do painel ao mesmo tempo → só uma grava; o revisor da 1ª fica", async () => {
      const id = await conjunto();
      const h = JSON.stringify({ [id]: hashNode(id, TRUTH, ALTS) });
      const outro = randomUUID();
      const a = await db.conn();
      const b = await db.conn();
      try {
        await a.query("BEGIN");
        const ra = (await a.query(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, $2) AS r`, [h, REVISOR])).rows[0].r;
        let terminou = false;
        const pb = b.query(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, $2) AS r`, [h, outro])
          .then((x) => ((terminou = true), x));
        await new Promise((r) => setTimeout(r, 400));
        ok(!terminou, "a 2ª aprovação não esperou a 1ª (sem trava)");
        await a.query("COMMIT");
        eq(ra, { updated: 1, skipped: 0 });
        eq((await pb).rows[0].r, { updated: 0, skipped: 1 });
        const [x] = await db.q(`SELECT status, reviewed_by FROM public.daily_choice_sets WHERE word_id = $1`, [id]);
        eq({ status: x.status, by: String(x.reviewed_by) }, { status: "aprovado", by: REVISOR });
      } finally {
        await a.end();
        await b.end();
      }
    });

    await t("corrida: definição da palavra trocada durante a aprovação → não aprova com a definição velha", async () => {
      const id = await conjunto();
      const a = await db.conn();
      const b = await db.conn();
      try {
        await a.query("BEGIN");
        await a.query(`UPDATE public.words SET meaning = 'definição trocada no meio' WHERE id = $1`, [id]);
        let terminou = false;
        const pb = b.query(`SELECT public.daily_choice_admin_review_hashed($1::jsonb, $2) AS r`,
          [JSON.stringify({ [id]: hashNode(id, TRUTH, ALTS) }), REVISOR]).then((x) => ((terminou = true), x));
        await new Promise((r) => setTimeout(r, 400));
        ok(!terminou, "a aprovação não esperou a troca da definição");
        await a.query("COMMIT");
        eq((await pb).rows[0].r, { updated: 0, skipped: 1 });
        eq((await estado(id)).status, "rascunho");
      } finally {
        await a.end();
        await b.end();
      }
    });
  }
} finally {
  if (palavras.length) {
    await db.q(`DELETE FROM public.daily_choice_sets WHERE word_id = ANY($1::uuid[])`, [palavras]);
    await db.q(`DELETE FROM public.words WHERE id = ANY($1::uuid[])`, [palavras]);
  }
  await db.close();
}

console.log(`\n${pass} ok, ${fail} falha(s)`);
if (fail) {
  console.log("D1 HASH NO BANCO FALHOU");
  process.exit(1);
}
console.log("D1 HASH NO BANCO OK");
