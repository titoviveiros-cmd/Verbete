import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const q = async (label, sql) => {
  try {
    const r = await client.query(sql);
    console.log(`== ${label} ==`);
    console.log(JSON.stringify(r.rows, null, 1).slice(0, 1200));
  } catch (e) {
    console.log(`== ${label} == ERROR: ${e.message}`);
  }
};

await q("cron jobs", "SELECT jobname, schedule, active FROM cron.job");
await q("words count by nivel", "SELECT nivel, count(*) FROM public.words GROUP BY nivel ORDER BY nivel");
await q("key RPCs exist", `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname IN ('choose_word','start_game','finish_reveal','advance_scoreboard_to_next_round_or_finished','apply_similarity_bonus','send_room_message','join_public_room','record_match_result','xp_to_level') ORDER BY proname`);
await q("achievements", "SELECT count(*) FROM public.achievements");
await q("set app.settings.supabase_url", "ALTER DATABASE postgres SET app.settings.supabase_url = 'https://wspztmimctgbjcmyzexn.supabase.co'");
await q("rooms UPDATE privs (should be host_id only)", `SELECT grantee, string_agg(column_name, ',') cols FROM information_schema.column_privileges WHERE table_name='rooms' AND privilege_type='UPDATE' AND grantee IN ('anon','authenticated') GROUP BY grantee`);

await client.end();
console.log("DONE");
