// Devolve a sala 8243 ao estado em que estava antes do teste visual
// (writing, rodada 3) com deadline curto para o cron retomar o fluxo.
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query(
  `UPDATE public.rooms SET status = 'writing',
     round_phase_ends_at = now() + interval '60 seconds'
   WHERE code = '8243'`);
const { rows } = await c.query(`SELECT code, status, current_round FROM public.rooms WHERE code = '8243'`);
console.log("restaurado:", JSON.stringify(rows[0]));
await c.end();
