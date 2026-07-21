// Auditoria do juiz de similaridade nas salas 3137 e 1918:
// defs + near_truth + verdade por rodada, e respostas do pg_net (erros?).
import pg from "pg";
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();
for (const code of ["3137", "1918"]) {
  const { rows: [room] } = await c.query(`SELECT id FROM public.rooms WHERE code = $1`, [code]);
  if (!room) { console.log(code, "não existe mais"); continue; }
  const { rows: defs } = await c.query(`
    SELECT d.round, p.nickname, d.player_id, substring(d.text from 1 for 55) AS text,
           d.is_truth, d.near_truth
      FROM public.definitions d
      LEFT JOIN public.players p ON p.id = d.player_id
     WHERE d.room_id = $1 ORDER BY d.round, d.is_truth DESC`, [room.id]);
  console.log(`\n=== sala ${code}`);
  for (const d of defs)
    console.log(` r${d.round} ${d.is_truth ? "VERDADE" : (d.nickname ?? d.player_id)} ${d.near_truth ? "🧠" : "  "} "${d.text}"`);
}
const { rows: net } = await c.query(`
  SELECT id, status_code, substring(content from 1 for 220) AS body, created
    FROM net._http_response
   ORDER BY created DESC LIMIT 12`);
console.log("\n=== últimas respostas pg_net (score-similarity):");
for (const r of net) console.log(` [${r.created}] ${r.status_code}: ${r.body}`);
await c.end();
