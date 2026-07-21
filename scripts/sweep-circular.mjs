// Higiene pós-lote: despublica definições CIRCULARES (significado contém a
// própria palavra) — vão para a fila 'ai_generated' do /admin/words.
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
const { rows } = await c.query(`
  UPDATE public.words
     SET status = 'ai_generated',
         review_notes = 'auto: definição circular (contém a própria palavra) — revisar'
   WHERE status = 'published'
     AND review_notes LIKE 'IA:%'
     AND position(lower(word) in lower(extensions.unaccent(meaning))) > 0
  RETURNING word, meaning`);
console.log(`despublicadas ${rows.length}:`);
for (const r of rows) console.log(` - ${r.word}: ${r.meaning}`);
const { rows: [tot] } = await c.query(
  `SELECT count(*)::int AS n FROM public.words WHERE status = 'published'`);
console.log(`publicadas agora: ${tot.n}`);
await c.end();
